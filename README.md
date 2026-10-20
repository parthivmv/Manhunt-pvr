# MANHUNT — Real-Life Hide & Seek Web App

A responsive browser app for a real-world hide-and-seek game. Players join a room using a room ID and username, choose **Hiders** or **Seekers**, and set:
- Game duration (1–240 minutes)
- Location ping interval (5–3600 seconds)

It includes browser GPS permission, timed location pings where **both hiders and seekers get all player locations**, an interactive OpenStreetMap-backed map, approximate distance and compass direction, a secret-code-based **caught system**, and **anti-rejoin protection** so caught players cannot rejoin under another name to play again.

## Features

1. **All Locations for Both Teams:**
   - Both Hiders and Seekers see all active player locations on the live map and in the distance list.
   - Distinct map markers: Blue for your location, Green for Hiders, Orange for Seekers, and Red for caught players.

2. **Caught System with Hider Secret Code:**
   - Every Hider is assigned a unique, private 4-digit code (e.g. `4829`) when they join.
   - Hiders keep their code secret until physically tagged or caught in real life.
   - Seekers enter the hider's 4-digit code in their live game interface to verify the catch.
   - Once confirmed, the hider is marked as caught across the room and taken out of the game.
   - When all hiders are caught, Seekers immediately win!

3. **Anti-Rejoin Protection:**
   - When a player gets caught, their device identifier is permanently flagged for that game room.
   - If a caught player attempts to leave, refresh, or rejoin using a different username or team, the app blocks them from rejoining.

4. **Live Map & Proximity Info:**
   - OpenStreetMap interactive view with zoom and "Fit all markers" controls.
   - Distance calculation (meters/km) and relative compass direction (e.g. `NE · 45°`).

## Run locally

1. Install Node.js 18 or newer.
2. Open a terminal inside the project folder.
3. Run:
   ```bash
   npm install
   npm start
   ```
4. Open `http://localhost:3000`.

For multiple devices on the same Wi-Fi, host the server on a computer reachable by those devices and open its LAN address. Browser geolocation usually requires **HTTPS** except on `localhost`, so use HTTPS for play on phones.

## How to play

1. Everyone opens the hosted URL.
2. One person creates a room ID (or taps **Random room ID**); everyone else joins the same room.
3. Enter your username and choose your team (**Hiders** or **Seekers**).
4. In the lobby, configure the game duration and location ping interval, then tap **Start game**.
5. Each player taps **Enable location sharing** and grants browser location permission.
6. **Hiders:** Watch the live map to evade seekers. Check your private 4-digit catch code. If a seeker physically tags you, give them your code.
7. **Seekers:** Hunt down hiders using the map pings and proximity indicators. When you catch a hider, ask for their code and enter it to eliminate them.
8. If all hiders are caught, Seekers win! If time runs out and any hider remains uncaught, Hiders win!

## Project files

- `server.js` — Express + Socket.IO room server, catch verification, ping scheduler, and anti-rejoin validation.
- `public/index.html` — Responsive dark UI, OpenStreetMap integration, catch code interface, and GPS location sharing.
- `package.json` — Dependencies and start command.
