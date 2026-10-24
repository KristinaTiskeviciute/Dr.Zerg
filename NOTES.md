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
- **Speed ramp** is capped at `MIN_FALL_INTERVAL_MS`.
- **Controls** (trying out): ← → move, ↑ rotate clockwise, ↓ or Space = soft drop (held), Z/X rotate counter-clockwise/clockwise. No hard drop. Previous try was ↑/↓ both rotating with Space as drop.

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
