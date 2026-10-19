# MANHUNT — Real-Life Hide & Seek Web App

A responsive browser app for a real-world hide-and-seek game. Players join a room using a room ID and username, choose **Hiders** or **Seekers**, and set:
- Game duration (1–240 minutes)
- Hiders → Seekers location ping interval (10–3600 seconds)
- Seekers → Hiders location ping interval (10–3600 seconds)

It includes browser GPS permission, timed opposing-team location pings, approximate distance and compass direction, a radar-style view, a room player list, and a game countdown.

## Run locally

1. Install Node.js 18 or newer.
2. Unzip this folder.
3. Open a terminal inside the extracted folder.
4. Run:
   ```bash
   npm install
   npm start
   ```
5. Open `http://localhost:3000`.

For multiple devices on the same Wi-Fi, host the server on a computer reachable by those devices and open its LAN address. Browser geolocation usually requires **HTTPS** except on `localhost`, so use HTTPS for play on phones.

## Deploy online

Deploy this Node app to a host that supports long-running Node.js processes and WebSockets (for example, a Node web service). Set the start command to `npm start`. Use the HTTPS URL provided by the host. Ensure WebSocket/Socket.IO connections are allowed.

## How to play

1. Everyone opens the same hosted URL.
2. One person creates a room ID (or taps Random room ID); everyone else uses the same ID.
3. Enter unique usernames and choose a team.
4. Before starting, set the game duration and each team's location ping interval.
5. Tap **Save settings**, then **Start game**. The room needs at least one hider and one seeker.
6. Each player taps **Enable location sharing** and grants browser location permission.
7. Each team's latest known locations are delivered to the opposing team on that team's configured ping schedule.

## Important limitations and safety

- **Consent:** GPS is opt-in. Tell all players what is shared and when; only play with people who agree to participate.
- **Ping timing:** A ping releases the latest location the server has received. If a player has not enabled GPS or has no GPS fix, they will not appear in that ping.
- **Not a production security system:** Room IDs are not passwords. This starter app has no accounts, persistent database, rate limits, or host/admin role. Room state is stored in server memory and is lost if the server restarts. Any player in the lobby can currently change settings or start the game. Add authentication, a room password/invite token, and host permissions before public use.
- **One server instance:** This in-memory version is designed for small games on a single server instance, not horizontal scaling.
- **Location accuracy:** GPS and distance can be inaccurate, especially indoors or in dense urban areas. Radar is a compass-style display, not a map. Use a safe, bounded play area; do not play near traffic, water, dangerous terrain, private property, or restricted areas.
- **End game:** When the configured duration expires, location pings stop and the game ends.

## Project files

- `server.js` — Express + Socket.IO room server and ping scheduler.
- `public/index.html` — complete responsive UI and browser GPS/radar.
- `package.json` — dependencies and start command.
