import { MAX_GARBAGE_PER_ATTACK, MIN_CLEARS_FOR_GARBAGE } from '../config';
import { Board } from './board';
import { Rng } from './rng';
import { Color } from './types';

/**
 * Garbage to send for one capsule's full chain: one piece per line cleared,
 * colored like those lines, capped. Nothing if fewer than the minimum.
 */
export function garbageForChain(clearedLineColors: Color[]): Color[] {
  if (clearedLineColors.length < MIN_CLEARS_FOR_GARBAGE) return [];
  return clearedLineColors.slice(0, MAX_GARBAGE_PER_ATTACK);
}

/**
 * Pick random, pairwise non-adjacent columns whose top cell is empty.
 * Returns fewer than `count` if the board can't fit them.
 */
export function pickGarbageColumns(board: Board, count: number, rng: Rng): number[] {
  const open: number[] = [];
  for (let c = 0; c < board.cols; c++) if (board.get(0, c) === null) open.push(c);

  // Enumerate all non-adjacent subsets of the open columns of the largest size we can manage.
  for (let n = Math.min(count, open.length); n > 0; n--) {
    const options: number[][] = [];
    const build = (from: number, chosen: number[]) => {
      if (chosen.length === n) { options.push([...chosen]); return; }
      for (let i = from; i < open.length; i++) {
        const last = chosen[chosen.length - 1];
        if (last !== undefined && open[i] - last < 2) continue;
        chosen.push(open[i]);
        build(i + 1, chosen);
        chosen.pop();
      }
    };
    build(0, []);
    if (options.length > 0) return options[rng.int(options.length)];
  }
  return [];
}
