const express = require("express");
const http = require("http");
const { Server } = require("socket.io");

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

function generateCatchCode(room) {
  const existingCodes = new Set(
    [...room.players.values()].map(p => p.catchCode).filter(Boolean)
  );
  let code;
  let attempts = 0;
  do {
    code = String(Math.floor(1000 + Math.random() * 9000));
    attempts++;
  } while (existingCodes.has(code) && attempts < 100);
  return code;
}

function publicPlayer(p) {
  return {
    id: p.id,
    username: p.username,
    team: p.team,
    connected: p.connected,
    hasLocation: !!p.location,
    lastSeen: p.lastSeen || null,
    caught: !!p.caught,
    caughtBy: p.caughtBy || null,
    caughtAt: p.caughtAt || null
  };
}

function roomState(room) {
  const players = [...room.players.values()].map(publicPlayer);
  const totalHiders = players.filter(p => p.team === "hiders").length;
  const uncaughtHiders = players.filter(p => p.team === "hiders" && !p.caught).length;
  const seekersCount = players.filter(p => p.team === "seekers").length;
  return {
    code: room.code,
    status: room.status,
    settings: room.settings,
    startedAt: room.startedAt,
    endsAt: room.endsAt,
    players,
    totalHiders,
    uncaughtHiders,
    seekersCount
  };
}

function emitRoom(room) {
  io.to(room.code).emit("room-state", roomState(room));
}

function ensureRoom(code) {
  let room = rooms.get(code);
  if (!room) {
    room = {
      code,
      status: "lobby",
      players: new Map(),
      caughtDeviceIds: new Set(),
      caughtPlayers: [],
      settings: { durationMin: 30, pingSec: 30, hiderPingSec: 30, seekerPingSec: 30 },
      startedAt: null,
      endsAt: null,
      pingTimer: null,
      endTimer: null
    };
    rooms.set(code, room);
  }
  return room;
}

function clearPings(room) {
  if (room.pingTimer) {
    clearInterval(room.pingTimer);
    room.pingTimer = null;
  }
}

function broadcastAllLocations(room) {
  if (room.status !== "playing") return;
  const players = [...room.players.values()];
  const locations = players
    .filter(p => p.location)
    .map(p => ({
      id: p.id,
      username: p.username,
      team: p.team,
      caught: !!p.caught,
      caughtBy: p.caughtBy || null,
      lat: p.location.lat,
      lon: p.location.lon,
      accuracy: p.location.accuracy,
      capturedAt: p.location.capturedAt
    }));

  // Both hiders and seekers receive all players' locations
  io.to(room.code).emit("location-ping", {
    locations,
    sentAt: Date.now(),
    nextPingSec: room.settings.pingSec || 30
  });
}

function startPings(room) {
  clearPings(room);
  // Send immediate locations, then schedule recurring pings
  broadcastAllLocations(room);
  const intervalSec = room.settings.pingSec || 30;
  room.pingTimer = setInterval(
    () => broadcastAllLocations(room),
    intervalSec * 1000
  );
}

function endGame(room, customMessage = null, winner = null) {
  clearPings(room);
  if (room.endTimer) {
    clearTimeout(room.endTimer);
    room.endTimer = null;
  }
  room.status = "ended";
  emitRoom(room);

  let message = customMessage;
  if (!message) {
    const uncaught = [...room.players.values()].filter(p => p.team === "hiders" && !p.caught);
    if (uncaught.length > 0) {
      winner = "hiders";
      message = `⏰ Time is up! Hiders win! ${uncaught.length} hider${uncaught.length === 1 ? "" : "s"} survived uncaught (${uncaught.map(h => h.username).join(", ")}).`;
    } else {
      winner = "seekers";
      message = "⏰ Time is up! All hiders were caught. Seekers win!";
    }
  }

  io.to(room.code).emit("game-ended", { message, winner });
}

io.on("connection", socket => {
  socket.on("join-room", (data, cb = () => {}) => {
    const code = roomCode(data?.room);
    const username = cleanName(data?.username);
    const team = data?.team === "seekers" ? "seekers" : "hiders";
    const deviceId = String(data?.deviceId || "").trim().slice(0, 64);

    if (!code || code.length < 3) return cb({ ok: false, error: "Room ID must be at least 3 letters/numbers." });
    if (!username) return cb({ ok: false, error: "Enter a username." });

    // Leave any previous room cleanly.
    if (socket.data.room) {
      const old = rooms.get(socket.data.room);
      if (old) {
        old.players.delete(socket.id);
        emitRoom(old);
        if (old.players.size === 0) {
          clearPings(old);
          if (old.endTimer) clearTimeout(old.endTimer);
          rooms.delete(old.code);
        }
      }
      socket.leave(socket.data.room);
    }

    const room = ensureRoom(code);
    if (room.status === "ended") return cb({ ok: false, error: "This game has ended. Create a new room ID." });

    // ANTI-REJOIN CHECK: If this device or username was caught in this room, block rejoin
    if (deviceId && room.caughtDeviceIds.has(deviceId)) {
      return cb({
        ok: false,
        error: "You have been caught in this game and cannot rejoin, even with another name!"
      });
    }

    if (room.caughtPlayers.some(cp => cp.username.toLowerCase() === username.toLowerCase())) {
      return cb({
        ok: false,
        error: "This player was already caught in this game and cannot rejoin!"
      });
    }

    // Generate unique 4-digit catch code if player is a hider
    const catchCode = team === "hiders" ? generateCatchCode(room) : null;

    const player = {
      id: socket.id,
      username,
      team,
      deviceId,
      connected: true,
      location: null,
      lastSeen: Date.now(),
      caught: false,
      catchCode
    };

    room.players.set(socket.id, player);
    socket.join(code);
    socket.data.room = code;
    socket.data.deviceId = deviceId;
    socket.data.team = team;

    cb({
      ok: true,
      state: roomState(room),
      playerId: socket.id,
      catchCode: player.catchCode
    });

    emitRoom(room);

    // Late joiners during active play get current game state and immediate locations
    if (room.status === "playing") {
      socket.emit("game-already-playing", {
        startedAt: room.startedAt,
        endsAt: room.endsAt,
        settings: room.settings
      });
      broadcastAllLocations(room);
    }
  });

  socket.on("update-settings", (data, cb = () => {}) => {
    const room = rooms.get(socket.data.room);
    if (!room) return cb({ ok: false, error: "Join a room first." });
    if (room.status !== "lobby") return cb({ ok: false, error: "Settings can only be changed in the lobby." });

    const pingSec = safeNum(data?.pingSec ?? data?.hiderPingSec, 5, 3600, 30);
    room.settings = {
      durationMin: safeNum(data?.durationMin, 1, 240, 30),
      pingSec,
      hiderPingSec: pingSec,
      seekerPingSec: pingSec
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
  });

  socket.on("catch-hider", (data, cb = () => {}) => {
    const code = socket.data.room;
    const room = rooms.get(code);
    if (!room) return cb({ ok: false, error: "Join a room first." });
    if (room.status !== "playing") return cb({ ok: false, error: "The game is not currently active." });

    const seeker = room.players.get(socket.id);
    if (!seeker || seeker.team !== "seekers") {
      return cb({ ok: false, error: "Only seekers can catch hiders." });
    }

    const inputCode = String(data?.code || "").trim();
    if (!inputCode) {
      return cb({ ok: false, error: "Please enter the hider's 4-digit code." });
    }

    // Find the uncaught hider with this code in the room
    const hider = [...room.players.values()].find(
      p => p.team === "hiders" && p.catchCode && p.catchCode.toLowerCase() === inputCode.toLowerCase()
    );

    if (!hider) {
      return cb({ ok: false, error: "Invalid code! No hider matches this code." });
    }

    if (hider.caught) {
      return cb({ ok: false, error: `${hider.username} has already been caught!` });
    }

    // Mark hider as caught
    hider.caught = true;
    hider.caughtBy = seeker.username;
    hider.caughtAt = Date.now();

    // Permanently record deviceId so they can never rejoin with another name
    if (hider.deviceId) {
      room.caughtDeviceIds.add(hider.deviceId);
    }
    room.caughtPlayers.push({
      username: hider.username,
      deviceId: hider.deviceId,
      caughtAt: hider.caughtAt,
      caughtBy: seeker.username
    });

    // Notify the caught hider
    io.to(hider.id).emit("you-are-caught", {
      caughtBy: seeker.username,
      caughtAt: hider.caughtAt
    });

    // Calculate remaining uncaught hiders
    const allHiders = [...room.players.values()].filter(p => p.team === "hiders");
    const uncaughtHiders = allHiders.filter(p => !p.caught);

    // Broadcast catch notification to everyone in room
    io.to(room.code).emit("player-caught", {
      hiderId: hider.id,
      hiderName: hider.username,
      seekerName: seeker.username,
      caughtAt: hider.caughtAt,
      uncaughtCount: uncaughtHiders.length,
      totalHiders: allHiders.length
    });

    emitRoom(room);
    broadcastAllLocations(room);

    // Check victory condition: if all hiders are caught, Seekers win!
    if (uncaughtHiders.length === 0) {
      endGame(
        room,
        `🎉 All hiders have been caught! Seekers win! (Last caught: ${hider.username})`,
        "seekers"
      );
    }

    cb({
      ok: true,
      message: `You caught ${hider.username}! (${uncaughtHiders.length} hider${uncaughtHiders.length === 1 ? "" : "s"} left)`
    });
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
