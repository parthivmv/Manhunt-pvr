const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const crypto = require("crypto");

const app = express();
const server = http.createServer(app);
const io = new Server(server);
const PORT = process.env.PORT || 3000;

app.use(express.static("public"));
app.get("/health", (_req, res) => res.json({ ok: true }));

// In-memory rooms: suitable for a small game/demo. Rooms reset when server restarts.
const rooms = new Map();
const cleanName = (v, max = 24) => String(v || "").trim().slice(0, max);
const roomCode = (v) => String(v || "").trim().toUpperCase().replace(/[^A-Z0-9-]/g, "").slice(0, 12);
const safeNum = (v, min, max, fallback) => {
  const n = Number(v);
  return Number.isFinite(n) ? Math.max(min, Math.min(max, n)) : fallback;
};

function publicPlayer(p) {
  return {
    id: p.id, username: p.username, team: p.team,
    connected: p.connected, hasLocation: !!p.location,
    lastSeen: p.lastSeen || null
  };
}
function roomState(room) {
  return {
    code: room.code, status: room.status, settings: room.settings,
    startedAt: room.startedAt, endsAt: room.endsAt,
    players: [...room.players.values()].map(publicPlayer)
  };
}
function emitRoom(room) {
  io.to(room.code).emit("room-state", roomState(room));
}
function ensureRoom(code) {
  let room = rooms.get(code);
  if (!room) {
    room = {
      code, status: "lobby", players: new Map(),
      settings: { durationMin: 30, hiderPingSec: 60, seekerPingSec: 120 },
      startedAt: null, endsAt: null, pingTimers: {}
    };
    rooms.set(code, room);
  }
  return room;
}
function clearPings(room) {
  for (const timer of Object.values(room.pingTimers)) clearInterval(timer);
  room.pingTimers = {};
}
function broadcastPings(room, teamWithLocation) {
  if (room.status !== "playing") return;
  const recipientsTeam = teamWithLocation === "hiders" ? "seekers" : "hiders";
  const players = [...room.players.values()];
  const locations = players
    .filter(p => p.team === teamWithLocation && p.location)
    .map(p => ({
      id: p.id, username: p.username, team: p.team,
      lat: p.location.lat, lon: p.location.lon,
      accuracy: p.location.accuracy, capturedAt: p.location.capturedAt
    }));
  // Only the opposing team receives the coordinates. Teammates and lobby get no coordinates.
  for (const p of players) {
    if (p.team === recipientsTeam) {
      io.to(p.id).emit("location-ping", {
        sourceTeam: teamWithLocation, locations,
        sentAt: Date.now(),
        nextPingSec: teamWithLocation === "hiders"
          ? room.settings.hiderPingSec : room.settings.seekerPingSec
      });
    }
  }
}
function startPings(room) {
  clearPings(room);
  // First ping happens immediately, then repeats at the configured interval.
  broadcastPings(room, "hiders");
  broadcastPings(room, "seekers");
  room.pingTimers.hiders = setInterval(
    () => broadcastPings(room, "hiders"), room.settings.hiderPingSec * 1000
  );
  room.pingTimers.seekers = setInterval(
    () => broadcastPings(room, "seekers"), room.settings.seekerPingSec * 1000
  );
}
function endGame(room) {
  clearPings(room);
  room.status = "ended";
  emitRoom(room);
  io.to(room.code).emit("game-ended", { message: "Game time is up." });
}

io.on("connection", socket => {
  socket.on("join-room", (data, cb = () => {}) => {
    const code = roomCode(data?.room);
    const username = cleanName(data?.username);
    const team = data?.team === "seekers" ? "seekers" : "hiders";
    if (!code || code.length < 3) return cb({ ok: false, error: "Room ID must be at least 3 letters/numbers." });
    if (!username) return cb({ ok: false, error: "Enter a username." });

    // Leave any previous room cleanly.
    if (socket.data.room) {
      const old = rooms.get(socket.data.room);
      if (old) {
        old.players.delete(socket.id);
        emitRoom(old);
        if (old.players.size === 0) { clearPings(old); rooms.delete(old.code); }
      }
      socket.leave(socket.data.room);
    }

    const room = ensureRoom(code);
    if (room.status === "ended") return cb({ ok: false, error: "This game has ended. Create a new room ID." });
    if (room.status === "playing" && !room.players.has(socket.id)) {
      return cb({ ok: false, error: "This game has already started; new players cannot join." });
    }

    const player = {
      id: socket.id, username, team, connected: true, location: null,
      lastSeen: Date.now()
    };
    room.players.set(socket.id, player);
    socket.join(code);
    socket.data.room = code;
    cb({ ok: true, state: roomState(room), playerId: socket.id });
    emitRoom(room);
  });

  socket.on("update-settings", (data, cb = () => {}) => {
    const room = rooms.get(socket.data.room);
    if (!room) return cb({ ok: false, error: "Join a room first." });
    if (room.status !== "lobby") return cb({ ok: false, error: "Settings can only be changed in the lobby." });
    room.settings = {
      durationMin: safeNum(data?.durationMin, 1, 240, 30),
      hiderPingSec: safeNum(data?.hiderPingSec, 10, 3600, 60),
      seekerPingSec: safeNum(data?.seekerPingSec, 10, 3600, 120)
    };
    emitRoom(room);
    cb({ ok: true });
  });

  socket.on("start-game", (_data, cb = () => {}) => {
    const room = rooms.get(socket.data.room);
    if (!room) return cb({ ok: false, error: "Join a room first." });
    if (room.status !== "lobby") return cb({ ok: false, error: "Game has already started." });
    const hiders = [...room.players.values()].filter(p => p.team === "hiders").length;
    const seekers = [...room.players.values()].filter(p => p.team === "seekers").length;
    if (!hiders || !seekers) return cb({ ok: false, error: "You need at least one hider and one seeker to start." });
    room.status = "playing";
    room.startedAt = Date.now();
    room.endsAt = room.startedAt + room.settings.durationMin * 60 * 1000;
    startPings(room);
    emitRoom(room);
    room.endTimer = setTimeout(() => endGame(room), room.settings.durationMin * 60 * 1000);
    cb({ ok: true });
  });

  socket.on("location-update", data => {
    const room = rooms.get(socket.data.room);
    if (!room || room.status !== "playing") return;
    const p = room.players.get(socket.id);
    if (!p || !Number.isFinite(Number(data?.lat)) || !Number.isFinite(Number(data?.lon))) return;
    const lat = Number(data.lat), lon = Number(data.lon);
    if (lat < -90 || lat > 90 || lon < -180 || lon > 180) return;
    p.location = {
      lat, lon,
      accuracy: safeNum(data.accuracy, 0, 100000, 0),
      capturedAt: Date.now()
    };
    p.lastSeen = Date.now();
    // Coordinates are not broadcast immediately. They are released on the opposing team's configured ping timer.
  });

  socket.on("leave-room", () => {
    const code = socket.data.room;
    const room = rooms.get(code);
    if (!room) return;
    room.players.delete(socket.id);
    socket.leave(code);
    socket.data.room = null;
    emitRoom(room);
    if (room.players.size === 0) {
      clearPings(room);
      if (room.endTimer) clearTimeout(room.endTimer);
      rooms.delete(code);
    }
  });

  socket.on("disconnect", () => {
    const code = socket.data.room;
    const room = rooms.get(code);
    if (!room) return;
    room.players.delete(socket.id);
    emitRoom(room);
    if (room.players.size === 0) {
      clearPings(room);
      if (room.endTimer) clearTimeout(room.endTimer);
      rooms.delete(code);
    }
  });
});

server.listen(PORT, () => console.log(`Manhunt running on http://localhost:${PORT}`));
