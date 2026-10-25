import { Color } from './types';

/** How far "to the right" each first-clear color sends garbage (Dr. Mario 64's rule). */
const TARGET_OFFSET: Record<Color, number> = { [Color.Blue]: 1, [Color.Yellow]: 2, [Color.Red]: 3 };

/**
 * Who gets a chain's garbage. Players sit in a circle in `alive` order (index = seat).
 * With two seats it always goes to the other player; with more, each color in the chain's
 * first clear picks one target: blue → next player still in, yellow → two over, red → three
 * over, wrapping around and skipping players who are out. In Outbreak mode it goes to
 * everyone still in.
 */
export function garbageTargets(
  from: number, alive: readonly boolean[], firstColors: readonly Color[], outbreak = false,
): number[] {
  const n = alive.length;
  const others: number[] = [];
  for (let k = 1; k < n; k++) {
    const j = (from + k) % n;
    if (alive[j]) others.push(j);
  }
  if (others.length === 0) return [];
  if (n === 2 || outbreak) return others;
  return [...new Set(firstColors.map(c => others[(TARGET_OFFSET[c] - 1) % others.length]))];
}
