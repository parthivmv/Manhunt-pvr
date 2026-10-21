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
app.get("/", (_req, res) => res.sendFile(__dirname + "/public/home.html"));
app.get("/room", (_req, res) => res.sendFile(__dirname + "/public/room.html"));

// ─── Fast In-memory stores ──────────────────────────────────────────────────
const rooms = new Map();
const DEVICE_ID_BLACKLIST = new Set();

// ─── Pure helpers (optimized for speed) ──────────────────────────────────────
const cleanName = (v, max = 24) => String(v || "").trim().slice(0, max);
const toRoomCode = (v) => String(v || "").trim().toUpperCase().replace(/[^A-Z0-9-]/g, "").slice(0, 12);
const clamp = (v, min, max, fallback) =>
  Number.isFinite(Number(v)) ? Math.max(min, Math.min(max, Number(v))) : fallback;
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

/** Generate a unique 4-digit seeker code for catching hiders. */
function generateSeekerCode(room) {
  const used = new Set([...room.players.values()].map(p => p.seekerCode).filter(Boolean));
  let code, attempts = 0;
  do { code = String(Math.floor(1000 + Math.random() * 9000)); } while (used.has(code) && ++attempts < 200);
  return code;
}

// ─── Fast Serialisers (no allocations) ───────────────────────────────────────
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
  const spectators = [...room.spectators.values()].map(publicPlayer);
  return {
    code: room.code,
    status: room.status,
    settings: room.settings,
    startedAt: room.startedAt,
    endsAt: room.endsAt,
    players,
    spectators,
    totalHiders: players.filter(p => p.team === "hiders").length,
    uncaughtHiders: players.filter(p => p.team === "hiders" && !p.caught).length
  };
}

const emitRoom = (room) => io.to(room.code).emit("room-state", roomState(room));

// ─── High-performance Room factory ─────────────────────────────────────────
function ensureRoom(code) {
  if (!rooms.has(code)) {
    rooms.set(code, {
      code,
      status: "lobby",
      players: new Map(),
      spectators: new Map(),
      caughtDeviceIds: new Set(),
      caughtPlayers: [],
      settings: { durationMin: 30, hiderPingSec: 60, seekerPingSec: 90 },
      startedAt: null,
      endsAt: null,
      pingTimers: { hiders: null, seekers: null },
      endTimer: null,
      createdAt: Date.now()
    });
  }
  return rooms.get(code);
}

// ─── Fast Ping engine ──────────────────────────────────────────────────────
function clearPings(room) {
  for (const key of Object.keys(room.pingTimers)) {
    if (room.pingTimers[key]) { clearInterval(room.pingTimers[key]); room.pingTimers[key] = null; }
  }
}

function broadcastLocations(room, teamFilter = null) {
  if (room.status !== "playing") return;
  const locations = [];
  for (const p of room.players.values()) {
    if (p.location && (!teamFilter || p.team === teamFilter)) {
      locations.push({
        id: p.id, username: p.username, team: p.team,
        caught: p.caught, caughtBy: p.caughtBy,
        lat: p.location.lat, lon: p.location.lon,
        accuracy: p.location.accuracy, capturedAt: p.location.capturedAt
      });
    }
  }

  io.to(room.code).emit("location-ping", {
    locations,
    teamFilter,
    sentAt: Date.now(),
    hiderPingSec: room.settings.hiderPingSec,
    seekerPingSec: room.settings.seekerPingSec
  });
}

function startPings(room) {
  clearPings(room);
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

// ─── Fast Game end with reset ───────────────────────────────────────────────
function endGame(room, customMessage = null) {
  clearPings(room);
  if (room.endTimer) { clearTimeout(room.endTimer); room.endTimer = null; }
  room.status = "ended";
  emitRoom(room);

  let message = customMessage;
  let winner = null;
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

  // Reset caught system after game ends
  setTimeout(() => {
    room.caughtDeviceIds.clear();
    room.caughtPlayers = [];
    // Clear blacklist entries for all players in this room
    for (const player of room.players.values()) {
      if (player.deviceId) {
        const blacklistKey = `${player.deviceId}_${room.code}`;
        DEVICE_ID_BLACKLIST.delete(blacklistKey);
      }
    }
    for (const spectator of room.spectators.values()) {
      if (spectator.deviceId) {
        const blacklistKey = `${spectator.deviceId}_${room.code}`;
        DEVICE_ID_BLACKLIST.delete(blacklistKey);
      }
    }
  }, 1000);
}

// ─── Cleanup a room if empty and reset caught system ─────────────────────────
function cleanupRoomIfEmpty(room) {
  const hasConnectedPlayers = [...room.players.values()].some(p => p.connected);
  const hasConnectedSpectators = [...room.spectators.values()].some(s => s.connected);

  if (!hasConnectedPlayers && !hasConnectedSpectators) {
    clearPings(room);
    if (room.endTimer) clearTimeout(room.endTimer);

    // Reset caught system when everyone leaves
    room.caughtDeviceIds.clear();
    room.caughtPlayers = [];

    // Clear all blacklist entries for this room
    for (const playerId of room.players.keys()) {
      const player = room.players.get(playerId);
      if (player?.deviceId) {
        DEVICE_ID_BLACKLIST.delete(`${player.deviceId}_${room.code}`);
      }
    }
    for (const spectatorId of room.spectators.keys()) {
      const spectator = room.spectators.get(spectatorId);
      if (spectator?.deviceId) {
        DEVICE_ID_BLACKLIST.delete(`${spectator.deviceId}_${room.code}`);
      }
    }
    rooms.delete(room.code);
  }
}

// ─── Socket handlers with performance optimizations ──────────────────────────
io.on("connection", socket => {

  socket.on("create-room", (data, cb = () => {}) => {
    const code = toRoomCode(data?.room);
    const username = cleanName(data?.username);
    const deviceId = String(data?.deviceId || "").trim().slice(0, 64);

    if (code.length < 3) return cb({ ok: false, error: "Room ID must be at least 3 characters." });
    if (!username) return cb({ ok: false, error: "Enter a username." });
    if (!deviceId) return cb({ ok: false, error: "Invalid device identifier." });

    // Fast check: if room exists, just emit join
    if (rooms.has(code)) {
      socket.emit("join-room", { room: code, username, team: data?.team, deviceId });
      return;
    }

    const room = ensureRoom(code);
    if (room.status === "playing" || room.status === "ended") {
      return cb({ ok: false, error: `Room ${code} is already in ${room.status} mode.` });
    }

    const team = data?.team === "seekers" ? "seekers" : "hiders";
    const catchCode = team === "hiders" ? generateCatchCode(room) : null;
    const seekerCode = team === "seekers" ? generateSeekerCode(room) : null;
    const player = {
      id: socket.id, username, team, deviceId,
      connected: true, location: null, lastSeen: Date.now(),
      caught: false, catchCode, seekerCode, isOwner: true
    };

    room.players.set(socket.id, player);
    socket.join(code);
    socket.data = { room: code, deviceId, team, isCreator: true };

    cb({ ok: true, state: roomState(room), playerId: socket.id, catchCode, seekerCode, isCreator: true });
    emitRoom(room);

    if (room.status === "playing") {
      socket.emit("game-already-playing", {
        startedAt: room.startedAt, endsAt: room.endsAt, settings: room.settings
      });
      broadcastLocations(room, "hiders");
      broadcastLocations(room, "seekers");
    }
  });

  socket.on("join-room", (data, cb = () => {}) => {
    const code = toRoomCode(data?.room);
    const username = cleanName(data?.username);
    const team = data?.team === "seekers" ? "seekers" : "hiders";
    const deviceId = String(data?.deviceId || "").trim().slice(0, 64);

    if (code.length < 3) return cb({ ok: false, error: "Room ID must be at least 3 characters." });
    if (!username) return cb({ ok: false, error: "Enter a username." });
    if (!deviceId) return cb({ ok: false, error: "Invalid device identifier." });

    // Clean up from previous room
    if (socket.data.room) {
      const old = rooms.get(socket.data.room);
      if (old) {
        old.players.delete(socket.id);
        old.spectators.delete(socket.id);
        emitRoom(old);
        cleanupRoomIfEmpty(old);
      }
      socket.leave(socket.data.room);
    }

    const room = ensureRoom(code);
    // Allow joining ended games to view final state and rejoin after reset

    // Check if caught - allow rejoin as spectator
    const isCaughtDevice = deviceId && room.caughtDeviceIds.has(deviceId);
    const isCaughtUsername = room.caughtPlayers.some(cp =>
      cp.username.toLowerCase() === username.toLowerCase() && cp.deviceId !== deviceId
    );

    if (isCaughtDevice || isCaughtUsername) {
      let existingSpectator = [...room.spectators.values()].find(s => s.deviceId === deviceId);
      if (!existingSpectator) {
        existingSpectator = [...room.spectators.values()].find(s =>
          s.username.toLowerCase() === username.toLowerCase()
        );
      }

      if (existingSpectator) {
        existingSpectator.id = socket.id;
        existingSpectator.connected = true;
        existingSpectator.lastSeen = Date.now();
      } else {
        existingSpectator = {
          id: socket.id, username, deviceId,
          connected: true, location: null, lastSeen: Date.now(),
          caught: true, team: "spectator", isSpectator: true, caughtTag: true
        };
        room.spectators.set(socket.id, existingSpectator);
      }

      socket.join(code);
      socket.data = { room: code, deviceId, team: "spectator", isCaught: true };

      cb({ ok: true, state: roomState(room), playerId: socket.id, isSpectator: true, isCaught: true });
      emitRoom(room);

      if (room.status === "playing") {
        socket.emit("game-already-playing", {
          startedAt: room.startedAt, endsAt: room.endsAt, settings: room.settings
        });
        // Don't send locations to caught players
      }
      return;
    }

    // Fast existing player check
    let existingPlayer = [...room.players.values()].find(p => p.deviceId === deviceId);
    if (!existingPlayer) {
      existingPlayer = [...room.players.values()].find(p =>
        p.username.toLowerCase() === username.toLowerCase()
      );
    }

    // Check for username conflicts
    if (existingPlayer && existingPlayer.deviceId !== deviceId && existingPlayer.connected) {
      return cb({ ok: false, error: "That username is already in use in this game. Choose a different username." });
    }

    // Restore or create player
    if (existingPlayer) {
      existingPlayer.id = socket.id;
      existingPlayer.deviceId = deviceId;
      existingPlayer.connected = true;
      existingPlayer.lastSeen = Date.now();

      // Ensure codes are set for rejoining players
      if (existingPlayer.team === "hiders" && !existingPlayer.catchCode) {
        existingPlayer.catchCode = generateCatchCode(room);
      }
      if (existingPlayer.team === "seekers" && !existingPlayer.seekerCode) {
        existingPlayer.seekerCode = generateSeekerCode(room);
      }

      socket.join(code);
      socket.data = { room: code, deviceId, team: existingPlayer.team };

      cb({
        ok: true,
        state: roomState(room),
        playerId: socket.id,
        catchCode: existingPlayer.team === "hiders" ? existingPlayer.catchCode : null,
        seekerCode: existingPlayer.team === "seekers" ? existingPlayer.seekerCode : null
      });
      emitRoom(room);

      if (room.status === "playing") {
        socket.emit("game-already-playing", {
          startedAt: room.startedAt, endsAt: room.endsAt, settings: room.settings
        });
        broadcastLocations(room, "hiders");
        broadcastLocations(room, "seekers");
      }
      return;
    }

    // New player
    const usernameConflict = [...room.players.values()].find(p =>
      p.username.toLowerCase() === username.toLowerCase() && p.deviceId !== deviceId
    );
    if (usernameConflict && usernameConflict.connected) {
      return cb({ ok: false, error: "That username is already in use in this game. Choose a different username." });
    }

    const catchCode = team === "hiders" ? generateCatchCode(room) : null;
    const seekerCode = team === "seekers" ? generateSeekerCode(room) : null;
    const player = {
      id: socket.id, username, team, deviceId,
      connected: true, location: null, lastSeen: Date.now(),
      caught: false, catchCode, seekerCode
    };

    room.players.set(socket.id, player);
    socket.join(code);
    socket.data = { room: code, deviceId, team };

    cb({ ok: true, state: roomState(room), playerId: socket.id, catchCode, seekerCode });
    emitRoom(room);

    if (room.status === "playing") {
      socket.emit("game-already-playing", {
        startedAt: room.startedAt, endsAt: room.endsAt, settings: room.settings
      });
      broadcastLocations(room, "hiders");
      broadcastLocations(room, "seekers");
    }
  });

  socket.on("update-settings", (data, cb = () => {}) => {
    const room = rooms.get(socket.data?.room);
    if (!room || room.status !== "lobby") return cb({ ok: false, error: "Invalid room or not in lobby." });

    room.settings = {
      durationMin: clamp(data?.durationMin, 1, 240, 30),
      hiderPingSec: clamp(data?.hiderPingSec, 5, 3600, 60),
      seekerPingSec: clamp(data?.seekerPingSec, 5, 3600, 90)
    };
    // Broadcast updated settings to ALL clients in the room
    io.to(room.code).emit("room-state", roomState(room));
    cb({ ok: true });
  });

  socket.on("start-game", (_data, cb = () => {}) => {
    const room = rooms.get(socket.data?.room);
    if (!room || room.status !== "lobby") return cb({ ok: false, error: "Invalid room or game not starting." });

    const hiders = [...room.players.values()].filter(p => p.team === "hiders").length;
    const seekers = [...room.players.values()].filter(p => p.team === "seekers").length;
    if (!hiders || !seekers) return cb({ ok: false, error: "Need at least one hider and one seeker to start." });

    room.status = "playing";
    room.startedAt = Date.now();
    room.endsAt = room.startedAt + room.settings.durationMin * 60_000;
    room.endTimer = setTimeout(() => endGame(room), room.settings.durationMin * 60_000);
    startPings(room);
    emitRoom(room);
    cb({ ok: true });
  });

  socket.on("location-update", data => {
    const room = rooms.get(socket.data?.room);
    if (!room || room.status !== "playing") return;
    const p = room.players.get(socket.id);
    if (!p) return;

    const lat = Number(data?.lat), lon = Number(data?.lon);
    if (!isValidCoord(lat, lon)) return;

    p.location = { lat, lon, accuracy: clamp(data?.accuracy, 0, 100_000, 0), capturedAt: Date.now() };
    p.lastSeen = Date.now();
  });

  socket.on("catch-hider", (data, cb = () => {}) => {
    const room = rooms.get(socket.data?.room);
    if (!room || room.status !== "playing") return cb({ ok: false, error: "Game not active." });

    const seeker = room.players.get(socket.id);
    if (!seeker || seeker.team !== "seekers") return cb({ ok: false, error: "Only seekers can catch hiders." });

    const input = String(data?.code || "").trim();
    if (!input) return cb({ ok: false, error: "Enter the hider's 4-digit code." });

    let hider = null;
    for (const p of room.players.values()) {
      if (p.team === "hiders" && p.catchCode === input && !p.caught) {
        hider = p;
        break;
      }
    }
    if (!hider) return cb({ ok: false, error: "Invalid or already caught hider." });

    hider.caught = true;
    hider.caughtBy = seeker.username;
    hider.caughtAt = Date.now();

    if (hider.deviceId) {
      const blacklistKey = `${hider.deviceId}_${room.code}`;
      DEVICE_ID_BLACKLIST.add(blacklistKey);
      room.caughtDeviceIds.add(hider.deviceId);
    }
    room.caughtPlayers.push({ username: hider.username, deviceId: hider.deviceId, caughtAt: hider.caughtAt, caughtBy: seeker.username });

    io.to(hider.id).emit("you-are-caught", { caughtBy: seeker.username, caughtAt: hider.caughtAt });

    const allHiders = [...room.players.values()].filter(p => p.team === "hiders");
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

  socket.on("leave-room", () => {
    const room = rooms.get(socket.data?.room);
    if (!room) return;

    const deviceId = socket.data.deviceId;
    const blacklistKey = `${deviceId}_${room.code}`;
    DEVICE_ID_BLACKLIST.delete(blacklistKey);

    room.players.delete(socket.id);
    socket.leave(socket.data.room);
    socket.data = null;
    emitRoom(room);
    cleanupRoomIfEmpty(room);
  });

  socket.on("disconnect", () => {
    const room = rooms.get(socket.data?.room);
    if (!room) return;

    const player = room.players.get(socket.id);
    if (player) {
      player.connected = false;
      player.lastSeen = Date.now();
    }

    const spectator = room.spectators.get(socket.id);
    if (spectator) {
      spectator.connected = false;
      spectator.lastSeen = Date.now();
    }

    emitRoom(room);
    cleanupRoomIfEmpty(room);
  });
});

server.listen(PORT, () => console.log(`Manhunt running → http://localhost:${PORT}`));