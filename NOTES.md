# Dr. Zerg — decisions and notes

Changes to the original spec, agreed in planning (2026-10-24).

## Rules decided
- **Capsules:** 9 colorings (IDs 0–8), including red-red, yellow-yellow, blue-blue. Each next ID = previous ID + random 0–15, wrapped into 0–8.
- **Germ height by level** (rows counted from the bottom): levels 0–14 → 10, 15–16 → 11, 17–18 → 12, 19–20 → 13. See `germMaxRows` in `src/config.ts`.
- **Germ placement:** same color never exactly two cells apart in any of the four directions (rules out 3-in-a-row and red–gap–red). If every color is blocked, try the next cell. Colors repeat yellow, red, blue, then random.
- **Garbage count:** one piece per line cleared during a capsule's whole chain, so two lines at once count as 2. Minimum 2 lines, capped at 4. No extra bonus.
- **Garbage-caused clears** don't send garbage back.
- **Separate random streams:** germs, capsules and garbage columns each get their own seeded RNG (`deriveSeed`). Receiving garbage never changes your capsule sequence.
- **Soft drop on the ground locks immediately.** Otherwise a landed capsule locks after `LOCK_DELAY_MS`.
- **Speed ramp:** 8% faster every 10 capsules (`SPEEDUP_FACTOR` 0.92), capped at `MIN_FALL_INTERVAL_MS`, reset each round. Each step plays a rising chime and the Speed label flashes "Med ▲N".
- **Music tempo** follows: +5% per speed-up (max 1.5×), plus an extra +0.2 once any board in play is down to 3 germs or fewer — an approximation of the original's endgame music change.
- **Feel, from the NES data** (drmar.io wiki): sideways auto-repeat 267 ms then every 100 ms (was 170/50 — too twitchy). NES capsule fall starts faster than ours (Low 0.67 s, Med 0.33 s, Hi 0.23 s per row); kept ours slower for now. NES garbage falls at 4 frames/row; ours is deliberately slower by request (220 ms/row; loose halves 200 ms/row).
- **Pause between capsules:** a new capsule spawns at once and is controllable, but hangs at the top for `ENTRY_DELAY_MS` (350 ms) before gravity starts; soft drop skips the hang. (Tried first: a flying toss from the preview — stressful; then a pause where the capsule was visible but not controllable — swallowed early rotations. Both removed.)
- **Rotating in the top row** works: the row above the bottle (the neck) counts as free space for a falling capsule.
- **Locking with a half in the neck:** the lower half goes in and clears normally; once the board settles, the top half drops in if there's room (and can continue the chain). If there's still no room, you've topped out. (The CPU still avoids these placements entirely.)
- **Garbage warning:** the moment the opponent's chain sends garbage, you hear a two-tone alarm and the queued pieces appear (blinking) as little pills on the bottle's left shoulder, until they drop after your capsule locks. Online: trigger the same when a `garbage` message arrives.
- **Fast garbage** (room/menu setting) also speeds up loose halves falling after a clear when you hold ↓ — same `FAST_GARBAGE_MULTIPLIER`.
- **Juice:** germs show a defeated face and blink before bursting; capsule flashes white on lock; small screen shake on chains (2+) and when garbage lands; germ "squish" and chain sparkle sounds.
- **Controls** (trying out): ← → move, ↑ rotate clockwise, ↓ or Space = soft drop (held), Z/X rotate counter-clockwise/clockwise. No hard drop. Previous try was ↑/↓ both rotating with Space as drop.

## Milestones (revised)
1. ✅ Single-player  2. ✅ Polish feel (ongoing)  3. Vs CPU  4. Relay server + rooms  5. Online versus  6. Deploy  7. Later

## Vs CPU
- `src/core/match.ts`: two boards, shared seed per round (new seed each round), garbage routed to the other board, best of 3 (`ROUNDS_TO_WIN`). Same class will drive online play.
- `src/core/ai.ts`: the CPU searches every reachable resting spot (breadth-first over down/left/right/rotate, so it finds tucks and slide-unders), scores the resulting board (germs cleared, runs through germs, junk on top of germs, mixed-color stacks, height) and, on Normal/Hard, looks one capsule ahead. It then steers the capsule there with key presses at its own pace, re-planning as it falls.
- Skills (`CPU_SKILLS` in config): Easy / Normal / Hard differ in think time, key speed, mistake rate, soft drop, chain building and attack pace.
- Attacking: it values moves that send garbage, recognizes "chain ready" boards (one more half would clear 2+ lines) and builds toward them, and gets more aggressive the longer it goes without attacking (`attackEveryS`: Easy 60 s, Normal 40 s, Hard 25 s). Firing a chain is always worth more than holding it.
- Panic mode: when capsule pieces (not germs) are within 6 rows of the top, it drops chain building and weighs stack height 5× — survive first.
- Human-ish timing: reaction time varies ±40%, and it sometimes hesitates 0.5–1.5 s (Easy 30%, Normal 8%, Hard never).
- Speed (2026-10-25 retune): all skills soft-drop, including down to the right height before a tuck/slide-under (it used to wait out gravity there — that was most of its time). Average time to clear its own board at Med: Easy ~3.7 min (L5) / ~5.3 min (L10), Normal ~2.1 / ~3.4 min, Hard ~1.2 / ~2.2 min. Hard makes no deliberate mistakes.
- One decision costs ~5–15 ms; if it ever causes a hitch on slow machines, spread the search over frames.
- Garbage placement stays random (spread-out columns), not aimed at tall stacks. "Garbage prefers tall columns" could be an optional room setting later.
- You and the CPU have separate level and speed. Fast garbage is a menu toggle in Vs CPU.

## Online rooms (milestone 4)
- Relay: `server/index.ts` (Cloudflare Worker + Durable Object per room via `partyserver`, location hint `enam`). Room logic in `server/lobby.ts`. Messages in `src/net/protocol.ts`; the server validates everything it receives.
- Rooms: 4-letter codes without I/L/O, created by the client; link `/r/CODE`. Max 2 players; first in is host; host passes on when the host's seat is freed.
- Player id is per browser tab (sessionStorage), so two tabs = two players, and a reload keeps your seat.
- Disconnects: seat kept for `RECONNECT_GRACE_S`, auto-reconnect with backoff, then the seat is freed.
- Lobby: name, your level/speed (per player), Fast garbage (host only, locked once started), ready flags; host starts when both are ready. Server sends seed + relative 3 s countdown.

## Online versus (milestone 5)
- Board snapshots (`src/net/snapshot.ts`): 1 char per cell + falling capsule + next + popping cells + queued garbage + germ count, under 400 bytes; sent at `BOARD_SNAPSHOT_HZ` when changed and at least every 500 ms (doubles as heartbeat). Server checks the shape and relays.
- Garbage: your `garbageOut` → `garbage` message → opponent's queue (warning sound + shoulder preview).
- Results: each client reports `cleared` / `toppedOut` / `forfeit`; the server's first report decides the round. First to 3 round wins (shown as stars) takes the match, like the original — changed from the spec's "best of 3"; next round starts automatically after `ROUND_BREAK_MS` (4 s) with a new seed; match over → room back to the lobby.
- After a match: **Play again** (`playAgain`) marks you ready; the next match starts automatically once both have pressed it (no host Start needed). **Back to lobby** to change settings first.
- Shared pause: P sends `pause`; both boards freeze and hide; resume = 3 s countdown for both.
- No word from the opponent for 2 s → both pause ("Connection problem…"). Your own connection down → "Reconnecting…".
- Opponent disconnects → "Opponent disconnected (15 s)"; back in time → 3 s countdown; not back → they lose the match and their seat is freed.
- Rejoining a room mid-round with no game in the tab (reload) → that round is forfeited; you play from the next round.

## 3–4 players (Vs CPU)
- Menu: Vs CPU → Opponents 1 / 2 / 3. CPUs are named Spike, Buzz, Peep (just "CPU" when there's one). All CPUs share the CPU level/speed/skill settings.
- `Match` handles 2–4 players. Garbage targeting (Dr. Mario 64): the colors of a chain's first clear pick targets — blue → next player in seating order, yellow → two over, red → three over, wrapping and skipping players who are out; two colors in the first clear hit two players. With 2 players it always goes to the other.
- Topping out knocks you out of the round (board greyed with OUT). The round goes to whoever clears first, or the last one standing; simultaneous clears or everyone out at once = draw. First to 3 round wins.
- Layout: one opponent at full size; two at 0.6×, three at 0.5×, side by side. Side panel lists every player's stars and germs.
- Online rooms take 2–4 players (seat order = join order). The host can start once 2+ are in and everyone is ready.
- Online targeting is done by the server (`src/core/targeting.ts`, shared with Vs CPU): clients send `garbage` with the chain's `firstColors`; the server sends it only to the targeted players.
- Knock-outs online: a `result` of toppedOut/forfeit marks you out (`out` message to everyone); the round ends when someone clears or one player is left (`lastStanding`). Someone gone past the grace period is knocked out and their seat freed; the match continues while 2+ players remain (with 2, the other player wins the match, as before).

## Visuals
- Pixel-art style: 16×16 sprites defined as text grids in `src/render/sprites.ts`, drawn on a small canvas and scaled up with pixelated rendering. Germs: red Spike (horns), yellow Buzz (antenna), blue Peep (three eyes).
- Font: Press Start 2P (SIL Open Font License), loaded from Google Fonts. Falls back to monospace offline.
- Retro page styling: checker background, CRT scanlines, square pixel buttons.

## Game controller
- `src/input/gamepad.ts`: any controller the browser maps to the standard layout (PS5 DualSense, Xbox…). Circle rotate ↻, Cross rotate ↺, D-pad/left stick move, down soft drop, D-pad up rotate ↻, Options pause. Cross/Options press the focused button on menus between rounds. Feeds the same input as the keyboard, so auto-repeat and the "held over from last capsule" rules match.
- Rumble (`src/input/rumble.ts`): lock tick, clears (stronger per chain step), garbage warning, garbage landing thump, round win/loss. Toggle button (🎮 Rumble) appears when a controller is connected. Uses the browser's `dual-rumble` effect where supported (Chrome/Edge); Firefox has no rumble.

## Audio
- Sound effects with **ZzFX** and music with **ZzFXM**, both MIT, vendored in `src/audio/` (no npm packages, no audio files). Sound definitions and the test tune are in `src/audio/sounds.ts`.
- Background music added (the spec originally said none). The current tune is a placeholder; a BeepBox export can replace it later.
- Mute (M key or button) and Music on/off buttons on every screen; both remembered in the browser.

## Online design decisions
- **No local 2-player.** Garbage is tested in single-player with the dev-only `9` key (sends yourself 2–4 pieces).
- **Level and speed are per player**, like the original. Same seed for both. Germ layouts match only if the levels match; the capsule sequence always matches.
- **Pause:** either player can pause; both boards freeze and hide; either can resume after a 3 s countdown.
- **Connection trouble:** heartbeat; nothing from the opponent for ~2 s → both boards auto-pause ("Connection problem…"). After `RECONNECT_GRACE_S`, the connected player wins the round.
- **No lockstep.** Each client simulates only its own board on the real clock; network delay only affects when you *see* opponent updates and garbage.
- **Start:** server sends "start in N ms" (relative), not an absolute time.
- **Simultaneous wins:** the server takes the first `result` it receives.
- **Reconnect identity:** random player ID kept in browser storage, sent with `join`. A page reload mid-round forfeits that round.
- **Hosting:** Cloudflare Workers + Durable Objects (via `partyserver`), frontend and relay in one `wrangler deploy`. Location hint: eastern North America.
- **New seed every round** of best-of-3.

## Later (not scheduled)
- **Flash mode** (from Dr. Mario 64): germs mixed with 3 flashing ones, one per color; first to clear all 3 wins. Good for short online rounds — could be a room setting.
- **3–4 players with color targeting** (from Dr. Mario 64): the color of your first clear in a combo picks the target. Blue → next player right, yellow → 2 right, red → 3 right, wrapping; two colors at once hit two players; retired players skipped.
- **Team Battle stock** (Dr. Mario 64): attacks to a teammate are stored (up to 4) and boost the next attack.
- **Marathon** (single-player): a germ row rises every 20 s; chains pause the timer.
- **Score Attack** mode (no garbage).
- **Levels 21–23** (up to 96 germs, as in Dr. Mario 64 Classic).
- Rebindable keys, mobile touch controls.
- Snapshot rate 20 Hz if the opponent's board feels too delayed.
- The name "Zerg" is a Blizzard trademark — fine among friends, reconsider if Dr. Zerg goes public.
- Cheap keyboards can drop keys when many are held; that's hardware ghosting, not the game.
