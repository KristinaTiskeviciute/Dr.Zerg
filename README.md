# Dr. Zerg

A browser falling-capsule puzzle game. Line up four of a color to squash the germs.

## Run locally

Needs Node.js 20 or newer.

```sh
npm install
npm run dev      # http://localhost:5173
npm test         # unit tests for the game core
npm run build    # production build into dist/
```

Dev-only extras: `?play=7` in the URL jumps straight into level 7, and the `9` key sends yourself 2–4 garbage pieces.

## Layout

- `src/core/` — pure game logic (board, capsules, matching, gravity, garbage, seeded RNG). No DOM; unit-tested.
- `src/render/` — canvas drawing (`drawBottle`, `drawCapsuleHalf`, `drawGerm`).
- `src/input/` — keyboard handling with DAS auto-repeat.
- `src/ui/` — DOM helpers and settings.
- `src/config.ts` — every tunable constant.

Deploy steps will be added at the deploy milestone. Design decisions and the "later" list are in [NOTES.md](NOTES.md).
