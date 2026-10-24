// All tunable constants live here. Starting values are guesses — tweak after play-testing.

// --- Board ---
export const BOARD_COLS = 8;
export const BOARD_ROWS = 16;

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
export const SPEEDUP_FACTOR = 0.95; // fall interval is multiplied by this at every speed-up
export const MIN_FALL_INTERVAL_MS = 80; // speed-up cap
export const SOFT_DROP_MULTIPLIER = 10;

// --- Movement feel ---
export const DAS_DELAY_MS = 170;
export const DAS_REPEAT_MS = 50;
export const LOCK_DELAY_MS = 250;

// --- Clearing and gravity ---
export const CLEAR_ANIMATION_MS = 300;
export const GRAVITY_STEP_MS = 120;

// --- Garbage ---
export const GARBAGE_FALL_STEP_MS = 120;
export const FAST_GARBAGE_MULTIPLIER = 4;
export const MAX_GARBAGE_PER_ATTACK = 4;
export const MIN_CLEARS_FOR_GARBAGE = 2;

// --- Online (used from milestone 3) ---
export const BOARD_SNAPSHOT_HZ = 10;
export const RECONNECT_GRACE_S = 15;

// --- Simulation ---
export const SIM_STEP_MS = 1000 / 60;
export const MAX_FRAME_MS = 250; // clamp after tab switches so we don't fast-forward

// --- Rendering ---
export const CELL_PX = 24;
export const GERM_WIGGLE_MS = 400; // time per wiggle frame
