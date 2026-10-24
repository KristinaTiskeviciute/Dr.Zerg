import { GERMS_PER_LEVEL, germMaxRows } from '../config';
import { Board } from './board';
import { Rng } from './rng';
import { Color, COLORS } from './types';

const COLOR_CYCLE: readonly Color[] = [Color.Yellow, Color.Red, Color.Blue];

export function germCountForLevel(level: number): number {
  return (level + 1) * GERMS_PER_LEVEL;
}

/**
 * Colors that may NOT go at (row, col): any germ exactly two cells away in one of
 * the four directions blocks its color. This rules out 3-in-a-row and red–gap–red.
 */
function blockedColors(board: Board, row: number, col: number): Set<Color> {
  const blocked = new Set<Color>();
  for (const [dr, dc] of [[-2, 0], [2, 0], [0, -2], [0, 2]]) {
    const cell = board.get(row + dr, col + dc);
    if (cell) blocked.add(cell.color);
  }
  return blocked;
}

/**
 * Seed the board with germs, classic style. Colors repeat yellow, red, blue, then a
 * random one. Each germ starts at a random cell in the allowed rows; if that cell is
 * taken or every color is blocked there, it tries the next cell in reading order.
 */
export function placeGerms(board: Board, level: number, rng: Rng): void {
  const count = germCountForLevel(level);
  const topRow = board.rows - germMaxRows(level);
  const cellsInArea = (board.rows - topRow) * board.cols;
  if (count > cellsInArea) throw new Error(`level ${level}: too many germs for the area`);

  for (let i = 0; i < count; i++) {
    let wanted = i % 4 < 3 ? COLOR_CYCLE[i % 4] : COLORS[rng.int(3)];
    const start = topRow * board.cols + rng.int(cellsInArea);
    let placed = false;
    for (let step = 0; step < cellsInArea && !placed; step++) {
      // Walk forward through the area, wrapping back to its top-left.
      const idx = topRow * board.cols + ((start - topRow * board.cols + step) % cellsInArea);
      const row = Math.floor(idx / board.cols);
      const col = idx % board.cols;
      if (board.get(row, col)) continue;
      const blocked = blockedColors(board, row, col);
      if (blocked.size === 3) continue;
      // Wanted color blocked: take the next allowed one in the cycle.
      let k = COLOR_CYCLE.indexOf(wanted);
      while (blocked.has(wanted)) wanted = COLOR_CYCLE[++k % 3];
      board.set(row, col, { kind: 'germ', color: wanted });
      placed = true;
    }
    // If no cell could take it, the germ is skipped (doesn't happen for levels 0–20 in practice; tested).
  }
}
