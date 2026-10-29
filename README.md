# Dr. Zerg

A browser falling-capsule puzzle game. Line up four of a color to squash the germs.

## Run locally

Needs Node.js 22 or newer (Wrangler, which runs the relay and deploys, requires it).

```sh
npm install
npm run dev          # the game: http://localhost:5173
npm run dev:server   # the multiplayer relay (in a second terminal), port 8787
npm test             # unit tests
npm run test:browser # smoke test in a real browser (needs Edge or Chrome installed)
npm run build        # type-check + production build into dist/
```

Solo and Vs CPU only need `npm run dev`. For online play, run both; Vite forwards
`/parties/*` to the relay. Always play on port 5173; opening 8787 in a browser just
redirects there. Each browser tab counts as a separate player, so you can
try a room on your own with two tabs: Online → Create room in one, open the link in the other.

After changing `wrangler.jsonc`, regenerate the Worker types with `npm run types:worker`.

The browser smoke test (`e2e/smoke.mjs`) checks what unit tests can't: the menu fits, Solo, Vs CPU and Local start and pause, controllers get around the menus and join, and the touch buttons keep clear of the bottle on phone-sized screens. Run it after layout or menu changes; it isn't part of `npm run deploy`.

Dev-only extras: `?play=7` in the URL jumps straight into level 7, and the `9` key sends yourself 2–4 garbage pieces.

## Layout

- `src/main.ts` — the game flow: starting each mode, the loop, pause, rounds, and online match messages. It wires the pieces below together.
- `src/core/` — pure game logic (board, capsules, matching, gravity, garbage, seeded RNG, matches, the CPU AI). No DOM; unit-tested.
- `src/play/` — what a session is (solo, Vs CPU/local, online) and when an online round is held; the result screens' wording (unit-tested).
- `src/render/` — canvas drawing (`drawBottle`, `drawCapsuleHalf`, `drawGerm`).
- `src/input/` — keyboard (DAS auto-repeat), controllers, rumble and touch gestures.
- `src/ui/` — the page: menus, lobby, local setup, chat, voice bar, HUD, the overlay, board sizing (`layout.ts`), top bar, touch buttons, controller menus, and settings.
- `src/audio/` — sound effects and music, generated in code.
- `src/net/` — message format shared with the server, the WebSocket connection, voice, and the worker that plays CPUs in online rooms.
- `src/config.ts` — every tunable constant.
- `server/` — the relay: a Cloudflare Worker with one Durable Object per room (`partyserver`). `lobby.ts` is the room logic (unit-tested).
- `e2e/` — the browser smoke test.

## Credits

- [ZzFX](https://github.com/KilledByAPixel/ZzFX) by Frank Force (MIT) — sound effects.
- [ZzFXM](https://github.com/keithclark/ZzFXM) by Keith Clark and Frank Force (MIT) — music renderer.

## Deploy

Live at **https://dr-zerg.dr-zerg.workers.dev** (Cloudflare Workers, free plan). The Worker serves
the game and runs the relay; rooms live in eastern North America, between Norway and California.

First time on a computer:

```sh
npx wrangler login   # opens the browser to log in to Cloudflare (account email must be verified)
```

Every deploy:

```sh
npm run deploy       # runs the tests, type-checks, builds dist/, then `wrangler deploy`
```

Players in a room during a deploy get disconnected and reconnect automatically, but the room's
state (and any match in progress) is reset, so deploy when nobody's playing.

Design decisions and the "later" list are in [NOTES.md](NOTES.md).
