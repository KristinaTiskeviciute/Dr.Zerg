// All tunable constants live here. Starting values are guesses — tweak after play-testing.

// --- Board ---
export const BOARD_COLS = 8;
export const BOARD_ROWS = 16;
/**
 * The neck above the bottle is this many columns wide, centred (columns 2–5). Only there can a
 * capsule half stick up above the top row; over the shoulders the bottle is closed.
 */
export const NECK_COLS = 4;

// --- Levels and germs ---
export const MIN_LEVEL = 0;
export const MAX_LEVEL = 20;
export const GERMS_PER_LEVEL = 4; // germ count = (level + 1) * GERMS_PER_LEVEL

/** How many rows (counted from the bottom) germs may occupy, per level. */
export function germMaxRows(level: number): number {
  if (level <= 14) return 10;
  if (level <= 16) return 11;
  if (level <= 18) return 12;
  return 13;
}

// --- Speed ---
export type Speed = 'low' | 'med' | 'high';
export const FALL_INTERVAL_MS: Record<Speed, number> = { low: 800, med: 500, high: 300 };
export const SPEEDUP_EVERY_N_CAPSULES = 10;
export const SPEEDUP_FACTOR = 0.92; // fall interval is multiplied by this at every speed-up
export const MUSIC_SPEEDUP_PER_STEP = 0.05; // music plays this much faster per speed-up step…
export const MUSIC_MAX_RATE = 1.5; // …up to this
export const ENDGAME_GERMS = 3; // at this many germs or fewer (on any board in a match), the music gets urgent
export const ENDGAME_MUSIC_BOOST = 0.2; // extra music speed in the endgame
export const MIN_FALL_INTERVAL_MS = 80; // speed-up cap
export const SOFT_DROP_MULTIPLIER = 10;

// --- Movement feel ---
// Holding left/right: one step at once, then auto-repeat after DAS_DELAY_MS, every DAS_REPEAT_MS.
// Values from the NES original (16 and 6 frames).
export const DAS_DELAY_MS = 267;
export const DAS_REPEAT_MS = 100;
export const LOCK_DELAY_MS = 250;
/** Pause between capsules while the next one is tossed from the preview into the bottle. */
export const ENTRY_DELAY_MS = 350;

// --- Clearing and gravity ---
export const CLEAR_ANIMATION_MS = 420;
export const GRAVITY_STEP_MS = 200; // loose halves after a clear (was 120; felt too fast)

// --- Garbage ---
export const GARBAGE_FALL_STEP_MS = 220; // was 120; felt too fast. Fast garbage + ↓ divides this by FAST_GARBAGE_MULTIPLIER
export const FAST_GARBAGE_MULTIPLIER = 4;
export const MAX_GARBAGE_PER_ATTACK = 4;
export const MIN_CLEARS_FOR_GARBAGE = 2;

// --- Versus ---
export const ROUNDS_TO_WIN = 3; // first to 3 round wins takes the match, like the original
export const OPPONENT_BOARD_SCALE = 1; // opponent's bottle size relative to yours

// --- CPU opponent ---
export type CpuSkillName = 'easy' | 'normal' | 'hard';
export interface CpuSkill {
  thinkMs: number; // typical pause before it starts moving a new capsule (varies ±40%)
  hesitateChance: number; // chance of an extra 0.5–1.5 s hesitation on a capsule
  moveMs: number; // time between its key presses
  mistakeChance: number; // chance it picks a worse spot on purpose
  topChoices: number; // how far down its list a mistake can reach
  softDrop: boolean; // drops capsules (and fast garbage) once in place
  lookahead: boolean; // plans with the next capsule too
  chainBuilding: number; // 0–1: how much it values setting up chains (which send garbage)
  attackEveryS: number; // target pace: the longer it goes without attacking, the harder it tries
}
export const CPU_SKILLS: Record<CpuSkillName, CpuSkill> = {
  easy: {
    thinkMs: 500, hesitateChance: 0.2, moveMs: 160, mistakeChance: 0.2, topChoices: 4,
    softDrop: true, lookahead: true, chainBuilding: 0.5, attackEveryS: 45,
  },
  normal: {
    thinkMs: 220, hesitateChance: 0.05, moveMs: 90, mistakeChance: 0.06, topChoices: 3,
    softDrop: true, lookahead: true, chainBuilding: 0.75, attackEveryS: 30,
  },
  hard: {
    thinkMs: 60, hesitateChance: 0, moveMs: 40, mistakeChance: 0, topChoices: 1,
    softDrop: true, lookahead: true, chainBuilding: 1, attackEveryS: 20,
  },
};

// --- Online (used from milestone 4) ---
export const BOARD_SNAPSHOT_HZ = 10;
export const RECONNECT_GRACE_S = 15;
/** After a round ends, the boards stay visible this long before the result covers them. */
export const ROUND_END_LINGER_MS = 2000;

// --- Simulation ---
export const SIM_STEP_MS = 1000 / 60;
export const MAX_FRAME_MS = 250; // clamp after tab switches so we don't fast-forward

// --- Rendering ---
export const CELL_PX = 16; // logical pixels per cell (sprite size); the page scales it up
export const GERM_WIGGLE_MS = 400; // time per wiggle frame
export const LOCK_FLASH_MS = 160; // white flash on a capsule as it locks
export const SHAKE_MS = 180; // screen shake on chains and garbage landing
export const SHAKE_PX = 3; // in sprite pixels
