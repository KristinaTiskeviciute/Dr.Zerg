# Dr. Zerg

A browser falling-capsule puzzle game. Line up four of a color to squash the germs.

## Run locally

Needs Node.js 20 or newer.

```sh
npm install
npm run dev          # the game: http://localhost:5173
npm run dev:server   # the multiplayer relay (in a second terminal), port 8787
npm test             # unit tests
npm run build        # type-check + production build into dist/
```

Solo and Vs CPU only need `npm run dev`. For online play, run both; Vite forwards
`/parties/*` to the relay. Each browser tab counts as a separate player, so you can
try a room on your own with two tabs: Online → Create room in one, open the link in the other.

After changing `wrangler.jsonc`, regenerate the Worker types with `npm run types:worker`.

Dev-only extras: `?play=7` in the URL jumps straight into level 7, and the `9` key sends yourself 2–4 garbage pieces.

## Layout

- `src/core/` — pure game logic (board, capsules, matching, gravity, garbage, seeded RNG). No DOM; unit-tested.
- `src/render/` — canvas drawing (`drawBottle`, `drawCapsuleHalf`, `drawGerm`).
- `src/input/` — keyboard handling with DAS auto-repeat.
- `src/ui/` — DOM helpers and settings.
- `src/config.ts` — every tunable constant.

- `src/audio/` — sound effects and music, generated in code.
- `src/net/` — message format shared with the server, and the WebSocket connection.
- `server/` — the relay: a Cloudflare Worker with one Durable Object per room (`partyserver`). `lobby.ts` is the room logic (unit-tested).

## Credits

- [ZzFX](https://github.com/KilledByAPixel/ZzFX) by Frank Force (MIT) — sound effects.
- [ZzFXM](https://github.com/keithclark/ZzFXM) by Keith Clark and Frank Force (MIT) — music renderer.

Deploy steps will be added at the deploy milestone. Design decisions and the "later" list are in [NOTES.md](NOTES.md).
