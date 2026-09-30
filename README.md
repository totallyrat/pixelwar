# PIXEL WAR

A multiplayer, real-time, pixel-art world-domination game on a real map of Earth.
Up to **20 human players** and **500 AI nations** fight over a pixelated globe rasterized from
Natural Earth data: expand, build an economy, raise armies and navies, sign pacts, betray allies,
and launch missiles or nukes. The server is authoritative; browsers only send orders.

Tablet-first (touch + pinch), also great with mouse and keyboard.

---

## Quick start

**Requirements:** Node.js 22.18+ (Node 24 recommended; it runs TypeScript directly).

| What | Windows | Any OS |
|---|---|---|
| Play locally / on your Wi-Fi | double-click **`PLAY.bat`** | `npm install` then `npm start` |
| Play with friends over the internet | double-click **`SHARE.bat`** | `npm install` then `npm run share` |

- `npm start` builds the client if needed and serves everything on **http://localhost:8080**.
  People on the same Wi-Fi can use the "network" address it prints (great for tablets).
- `npm run share` does the same and also opens a free **Cloudflare quick tunnel**: no account,
  no port forwarding. It prints (and on Windows copies) a public `https://….trycloudflare.com`
  link. If `cloudflared` is missing, it offers to install it with `winget` (Windows) or tells you
  the one-line install (`brew install cloudflared` on macOS). The link changes on every run.
- In the game: **Create room** and share the 5-letter code or the **Copy invite link** button.
  Friends open the link and land straight in your lobby. **Quick solo** starts a game against AI
  immediately.

Rooms are snapshotted to `server/data/rooms/` every 20 s. If the server restarts, matches resume
and players reconnect automatically (sessions are remembered per browser tab).

## How to play

- **Spawn phase (20 s):** tap anywhere on land to found your capital (tap again to move it).
  AI nations then appear at random places around the world, just as small as you.
- **Expand / attack:** set **SEND TROOPS %** in the bottom bar, then **double-tap** or
  **long-press** a tile (desktop: **right-click**, or right-drag and release). Your troops spread
  from your border as a wave, pulled toward the spot you picked. Plains are cheap, forest and
  mountains are slow and costly, bunkers make tiles far harder to take. Opposing fronts cancel out.
- **Tap** a tile for its info card and context actions (build, upgrade, attack, invade by sea,
  missile/bomber/nuke, diplomacy). Pinch or scroll to zoom, drag to pan, tap the minimap to jump.
- **Economy:** Farms feed your people (starvation leads to desertion, unrest and rebellion). Cities
  raise population, income and building slots. Factories give production. Oil wells and uranium mines
  must sit on deposits (black and green dots on the map).
- **Army:** Mobilization sets the share of the population under arms. Barracks recruit faster.
  Tank battalions cost no population and dominate open terrain.
- **Navy:** Shipyards (coast) build warships, which sink enemy ships and shell coasts, and transports
  for naval invasions.
- **Strategic weapons:** Silos launch range-limited missiles; Air Defense (boosted by Radar) shoots
  them down. Nukes need a Nuclear Facility, a Silo and uranium. Every launch triggers a **global alert**
  with a **15 s interception window**: defenders can fire an interceptor from the alert. Detonations
  wipe the core, leave fallout, and make AI nations turn on the launcher. Too many detonations cause
  **nuclear winter**, which cuts food output for everyone.
- **Diplomacy:** non-aggression pacts (5 min), alliances (shared vision, aid, optional shared victory),
  war declarations and **betrayal** (breaking a treaty makes you a traitor for 2 minutes: weaker
  defence, and every AI remembers). Chat (global / alliance) and map pings.
- **Win:** control **70 %** of the world's land (alone or as an alliance), be the last human nation or
  alliance standing, or have the top score when the optional time limit ends.

**Keys:** WASD/arrows pan · +/- zoom · 1-9 troop % · B build · R army · G diplomacy · T chat ·
L ranks · H home · P ping · Esc cancel.

## Architecture

```
shared/   balance.ts (ALL gameplay numbers), mapdata.ts (map format + geometry), protocol.ts (wire format)
server/   main.ts (HTTP + WebSocket + persistence), room.ts (lobby, tick loop, per-client diffs)
          sim/  game.ts (tick orchestration, territory, spawning, win), combat.ts (conquest wave),
                economy.ts, buildings.ts, units.ts (ships/flights/nukes), nav.ts (naval A*),
                diplomacy.ts, vision.ts (fog), ai.ts (AI nations)
client/   src/ main.ts, net.ts, world.ts (client mirror), input.ts (touch/mouse/keys), audio.ts (synth SFX),
          render/ renderer.ts (chunked canvas), sprites.ts (pixel glyphs), ui/ hud.ts, lobby.ts
tools/    mapgen/ (Natural Earth -> pixel map), start/share/dev launchers, bench.ts, selftest.ts
```

- **Map:** Natural Earth 1:50m countries, lakes and geography regions, rasterized with a Miller
  projection cropped to 82°N–61°S (exactly 2:1, no giant Antarctica strip). Terrain: ocean, shallows,
  plains, forest, mountain, desert, ice, coast. Mountains and deserts come from Natural Earth region
  polygons, forests from climate bands with noise, oil and uranium from hand-authored real-world basins.
  Three sizes: 512×256, 1024×512 (default), 2048×1024. The map wraps east–west.
- **Simulation:** fixed 5 ticks/s, seeded RNG, all state in one plain object (snapshotted with
  `v8.serialize`). Territory is struct-of-arrays typed arrays with incremental per-player owned/border
  lists, so nothing scans the whole map per tick. Land combat uses troop pools and priority-queue
  "fronts"; ships, planes, missiles and nukes are discrete entities.
- **Network:** clients send small JSON orders. Each tick the server sends every client one binary
  frame: changed tiles (grouped by owner, delta-coded varints, encoded once per tick), fog updates
  (RLE), visible ships, and that client's events (filtered by fog). Joining or reconnecting sends a
  full snapshot (run-length-encoded ownership). WebSocket per-message deflate is on.
- **Fog of war (partial):** land ownership is public; buildings, ships, strikes and troop counts are
  hidden outside your vision (territory + margin, radar, ships, allies).
- **Rendering:** the map is split into 128×128 chunk canvases and only dirty chunks are re-uploaded.
  Overlays (buildings, ships, arcs, effects, labels) are drawn per frame, and frames are only drawn
  when something changed or is animating. The device pixel ratio is capped at 2 for tablets.

## Performance (measured on this machine)

| Scenario | Server tick (avg / p99) |
|---|---|
| 1024×512, 500 AIs, 30-min match | 0.4 ms / 3 ms |
| 2048×1024, 500 AIs | 1.8 ms / 10 ms |

The tick budget is 200 ms. Client: about 1 ms per frame and 3 ms per server update with 500 nations
on the large map. Run `npm run bench -- medium 500 600` to reproduce.

## Tuning & development

- **Balance:** everything is in [`shared/balance.ts`](shared/balance.ts): terrain, buildings,
  units, economy, combat, missiles/nukes, AI personalities, win and score. Distances are in tiles on
  the 1024 map and scale automatically.
- `npm run dev` runs a hot-reloading client on :5173 and an auto-restarting server on :8080.
- `node tools/selftest.ts` drives two scripted humans through every system (building, units,
  alliance, betrayal, missiles, bombers, naval invasion, nuke + interception, fallout, snapshot restore).
- `npm run mapgen` regenerates the maps (`PREVIEW=1` also writes PNG previews to `tools/mapgen/cache`).
- `npm run typecheck`.
- Testing several players on one PC: open another tab with `http://localhost:8080/?new`.

Map data © [Natural Earth](https://www.naturalearthdata.com/) (public domain).
