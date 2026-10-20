const express = require("express");
const http    = require("http");
const { Server } = require("socket.io");

// ─── App bootstrap ────────────────────────────────────────────────────────────
const app    = express();
const server = http.createServer(app);
const io     = new Server(server, { pingTimeout: 30000, pingInterval: 10000 });
const PORT   = process.env.PORT || 3000;

app.use(express.static("public"));
app.get("/health", (_req, res) => res.json({ ok: true }));

// ─── In-memory store ──────────────────────────────────────────────────────────
const rooms = new Map();

// ─── Pure helpers (no side-effects) ──────────────────────────────────────────
const cleanName = (v, max = 24) => String(v || "").trim().slice(0, max);
const toRoomCode = (v) => String(v || "").trim().toUpperCase().replace(/[^A-Z0-9-]/g, "").slice(0, 12);
const clamp = (v, min, max, fallback) => {
  const n = Number(v);
  return Number.isFinite(n) ? Math.max(min, Math.min(max, n)) : fallback;
};
const isValidCoord = (lat, lon) =>
  Number.isFinite(lat) && Number.isFinite(lon) &&
  lat >= -90 && lat <= 90 && lon >= -180 && lon <= 180;

/** Generate a unique 4-digit code for a hider within the room. */
function generateCatchCode(room) {
  const used = new Set([...room.players.values()].map(p => p.catchCode).filter(Boolean));
  let code, attempts = 0;
  do { code = String(Math.floor(1000 + Math.random() * 9000)); } while (used.has(code) && ++attempts < 200);
  return code;
}

// ─── Serialisers ──────────────────────────────────────────────────────────────
/** Strip server-only fields before sending a player to clients. */
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
  const players       = [...room.players.values()].map(publicPlayer);
  const totalHiders   = players.filter(p => p.team === "hiders").length;
  const uncaughtHiders = players.filter(p => p.team === "hiders" && !p.caught).length;
  return {
    code: room.code,
    status: room.status,
    settings: room.settings,
    startedAt: room.startedAt,
    endsAt: room.endsAt,
    players,
    totalHiders,
    uncaughtHiders
  };
}

const emitRoom = (room) => io.to(room.code).emit("room-state", roomState(room));

// ─── Room factory ─────────────────────────────────────────────────────────────
function ensureRoom(code) {
  if (!rooms.has(code)) {
    rooms.set(code, {
      code,
      status: "lobby",
      players: new Map(),
      caughtDeviceIds: new Set(),
      caughtPlayers: [],
      settings: {
        durationMin: 30,
        hiderPingSec: 30,   // how often HIDERS' locations are broadcast
        seekerPingSec: 60   // how often SEEKERS' locations are broadcast
      },
      startedAt: null,
      endsAt: null,
      pingTimers: { hiders: null, seekers: null },
      endTimer: null
    });
  }
  return rooms.get(code);
}

// ─── Ping engine ──────────────────────────────────────────────────────────────
function clearPings(room) {
  for (const key of Object.keys(room.pingTimers)) {
    if (room.pingTimers[key]) { clearInterval(room.pingTimers[key]); room.pingTimers[key] = null; }
  }
}

/**
 * Broadcast all players' locations.
 * @param {object} room
 * @param {string|null} teamFilter - if set, only include that team's locations in this ping
 */
function broadcastLocations(room, teamFilter = null) {
  if (room.status !== "playing") return;
  const locations = [...room.players.values()]
    .filter(p => p.location && (!teamFilter || p.team === teamFilter))
    .map(p => ({
      id: p.id, username: p.username, team: p.team,
      caught: !!p.caught, caughtBy: p.caughtBy || null,
      lat: p.location.lat, lon: p.location.lon,
      accuracy: p.location.accuracy, capturedAt: p.location.capturedAt
    }));

  io.to(room.code).emit("location-ping", {
    locations,
    teamFilter,          // lets the client label the ping (e.g. "Hider locations updated")
    sentAt: Date.now(),
    hiderPingSec: room.settings.hiderPingSec,
    seekerPingSec: room.settings.seekerPingSec
  });
}

/**
 * Start two independent ping timers — one for hider locations, one for seeker locations.
 * Both are broadcast to everyone in the room.
 */
function startPings(room) {
  clearPings(room);

  // Immediate first ping for both teams
  broadcastLocations(room, "hiders");
  broadcastLocations(room, "seekers");

  room.pingTimers.hiders = setInterval(
    () => broadcastLocations(room, "hiders"),
    room.settings.hiderPingSec * 1000
  );
  room.pingTimers.seekers = setInterval(
    () => broadcastLocations(room, "seekers"),
    room.settings.seekerPingSec * 1000
  );
}

// ─── Game end ─────────────────────────────────────────────────────────────────
function endGame(room, customMessage = null) {
  clearPings(room);
  if (room.endTimer) { clearTimeout(room.endTimer); room.endTimer = null; }
  room.status = "ended";
  emitRoom(room);

  let message = customMessage;
  let winner  = null;
  if (!message) {
    const alive = [...room.players.values()].filter(p => p.team === "hiders" && !p.caught);
    if (alive.length > 0) {
      winner = "hiders";
      message = `⏰ Time's up! Hiders win — ${alive.length} hider${alive.length > 1 ? "s" : ""} survived (${alive.map(h => h.username).join(", ")}).`;
    } else {
      winner = "seekers";
      message = "⏰ Time's up! All hiders caught — Seekers win!";
    }
  }
  io.to(room.code).emit("game-ended", { message, winner });
}

// ─── Cleanup a room if empty ──────────────────────────────────────────────────
function cleanupRoomIfEmpty(room) {
  if (room.players.size === 0) {
    clearPings(room);
    if (room.endTimer) clearTimeout(room.endTimer);
    rooms.delete(room.code);
  }
}

// ─── Socket handlers ──────────────────────────────────────────────────────────
io.on("connection", socket => {

  // ── join-room ───────────────────────────────────────────────────────────────
  socket.on("join-room", (data, cb = () => {}) => {
    const code     = toRoomCode(data?.room);
    const username = cleanName(data?.username);
    const team     = data?.team === "seekers" ? "seekers" : "hiders";
    const deviceId = String(data?.deviceId || "").trim().slice(0, 64);

    if (code.length < 3)  return cb({ ok: false, error: "Room ID must be at least 3 characters." });
    if (!username)        return cb({ ok: false, error: "Enter a username." });

    // Leave previous room cleanly
    if (socket.data.room) {
      const old = rooms.get(socket.data.room);
      if (old) {
        old.players.delete(socket.id);
        emitRoom(old);
        cleanupRoomIfEmpty(old);
      }
      socket.leave(socket.data.room);
    }

    const room = ensureRoom(code);
    if (room.status === "ended") return cb({ ok: false, error: "This game has ended. Use a new room ID." });

    // Anti-rejoin: device fingerprint check
    if (deviceId && room.caughtDeviceIds.has(deviceId))
      return cb({ ok: false, error: "You were caught in this game and cannot rejoin, even with another name!" });

    // Anti-rejoin: username check
    if (room.caughtPlayers.some(cp => cp.username.toLowerCase() === username.toLowerCase()))
      return cb({ ok: false, error: "This player was already caught and cannot rejoin!" });

    const catchCode = team === "hiders" ? generateCatchCode(room) : null;
    const player = {
      id: socket.id, username, team, deviceId,
      connected: true, location: null, lastSeen: Date.now(),
      caught: false, catchCode
    };

    room.players.set(socket.id, player);
    socket.join(code);
    socket.data.room     = code;
    socket.data.deviceId = deviceId;
    socket.data.team     = team;

    cb({ ok: true, state: roomState(room), playerId: socket.id, catchCode });
    emitRoom(room);

    if (room.status === "playing") {
      socket.emit("game-already-playing", {
        startedAt: room.startedAt, endsAt: room.endsAt, settings: room.settings
      });
      // Give the late joiner an immediate location snapshot
      broadcastLocations(room, "hiders");
      broadcastLocations(room, "seekers");
    }
  });

  // ── update-settings ─────────────────────────────────────────────────────────
  socket.on("update-settings", (data, cb = () => {}) => {
    const room = rooms.get(socket.data.room);
    if (!room)                       return cb({ ok: false, error: "Join a room first." });
    if (room.status !== "lobby")     return cb({ ok: false, error: "Settings can only change in the lobby." });

    room.settings = {
      durationMin:  clamp(data?.durationMin, 1, 240, 30),
      hiderPingSec: clamp(data?.hiderPingSec, 5, 3600, 30),
      seekerPingSec: clamp(data?.seekerPingSec, 5, 3600, 60)
    };
    emitRoom(room);
    cb({ ok: true });
  });

  // ── start-game ──────────────────────────────────────────────────────────────
  socket.on("start-game", (_data, cb = () => {}) => {
    const room = rooms.get(socket.data.room);
    if (!room)                   return cb({ ok: false, error: "Join a room first." });
    if (room.status !== "lobby") return cb({ ok: false, error: "Game already started." });

    const hiders  = [...room.players.values()].filter(p => p.team === "hiders").length;
    const seekers = [...room.players.values()].filter(p => p.team === "seekers").length;
    if (!hiders || !seekers)
      return cb({ ok: false, error: "Need at least one hider and one seeker to start." });

    room.status    = "playing";
    room.startedAt = Date.now();
    room.endsAt    = room.startedAt + room.settings.durationMin * 60_000;
    room.endTimer  = setTimeout(() => endGame(room), room.settings.durationMin * 60_000);
    startPings(room);
    emitRoom(room);
    cb({ ok: true });
  });

  // ── location-update ─────────────────────────────────────────────────────────
  socket.on("location-update", data => {
    const room = rooms.get(socket.data.room);
    if (!room || room.status !== "playing") return;
    const p = room.players.get(socket.id);
    if (!p) return;

    const lat = Number(data?.lat), lon = Number(data?.lon);
    if (!isValidCoord(lat, lon)) return;

    p.location = { lat, lon, accuracy: clamp(data?.accuracy, 0, 100_000, 0), capturedAt: Date.now() };
    p.lastSeen = Date.now();
  });

  // ── catch-hider ─────────────────────────────────────────────────────────────
  socket.on("catch-hider", (data, cb = () => {}) => {
    const room = rooms.get(socket.data.room);
    if (!room)                        return cb({ ok: false, error: "Join a room first." });
    if (room.status !== "playing")    return cb({ ok: false, error: "Game is not active." });

    const seeker = room.players.get(socket.id);
    if (!seeker || seeker.team !== "seekers")
      return cb({ ok: false, error: "Only seekers can catch hiders." });

    const input = String(data?.code || "").trim();
    if (!input) return cb({ ok: false, error: "Enter the hider's 4-digit code." });

    const hider = [...room.players.values()].find(
      p => p.team === "hiders" && p.catchCode && p.catchCode === input
    );
    if (!hider)        return cb({ ok: false, error: "Invalid code — no matching hider." });
    if (hider.caught)  return cb({ ok: false, error: `${hider.username} is already caught!` });

    // Mark caught
    hider.caught   = true;
    hider.caughtBy = seeker.username;
    hider.caughtAt = Date.now();

    if (hider.deviceId) room.caughtDeviceIds.add(hider.deviceId);
    room.caughtPlayers.push({ username: hider.username, deviceId: hider.deviceId, caughtAt: hider.caughtAt, caughtBy: seeker.username });

    io.to(hider.id).emit("you-are-caught", { caughtBy: seeker.username, caughtAt: hider.caughtAt });

    const allHiders     = [...room.players.values()].filter(p => p.team === "hiders");
    const uncaughtHiders = allHiders.filter(p => !p.caught);

    io.to(room.code).emit("player-caught", {
      hiderId: hider.id, hiderName: hider.username, seekerName: seeker.username,
      caughtAt: hider.caughtAt, uncaughtCount: uncaughtHiders.length, totalHiders: allHiders.length
    });

    emitRoom(room);
    broadcastLocations(room, "hiders");

    if (uncaughtHiders.length === 0)
      endGame(room, `🎉 All hiders caught! Seekers win! (Last: ${hider.username})`);

    cb({ ok: true, message: `You caught ${hider.username}! (${uncaughtHiders.length} hider${uncaughtHiders.length === 1 ? "" : "s"} left)` });
  });

  // ── leave-room ──────────────────────────────────────────────────────────────
  socket.on("leave-room", () => {
    const room = rooms.get(socket.data.room);
    if (!room) return;
    room.players.delete(socket.id);
    socket.leave(socket.data.room);
    socket.data.room = null;
    emitRoom(room);
    cleanupRoomIfEmpty(room);
  });

  // ── disconnect ──────────────────────────────────────────────────────────────
  socket.on("disconnect", () => {
    const room = rooms.get(socket.data.room);
    if (!room) return;
    room.players.delete(socket.id);
    emitRoom(room);
    cleanupRoomIfEmpty(room);
  });
});

server.listen(PORT, () => console.log(`Manhunt running → http://localhost:${PORT}`));
