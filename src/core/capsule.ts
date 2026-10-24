import { Board } from './board';
import { Color, Pos } from './types';

/**
 * A falling capsule. (row, col) is its bottom-left cell.
 * Orientation, rotating clockwise 0 → 1 → 2 → 3 → 0:
 *   0: [a b]   horizontal, a left
 *   1: a over b (vertical)
 *   2: [b a]   horizontal, b left
 *   3: b over a (vertical)
 */
export interface Capsule {
  row: number;
  col: number;
  orientation: 0 | 1 | 2 | 3;
  colors: readonly [Color, Color];
}

export interface CapsuleHalf {
  pos: Pos;
  color: Color;
}

export function isVertical(c: Capsule): boolean {
  return c.orientation === 1 || c.orientation === 3;
}

/** The two halves, [a, b], with their board positions. */
export function capsuleHalves(c: Capsule): [CapsuleHalf, CapsuleHalf] {
  const [ca, cb] = c.colors;
  const bl = { row: c.row, col: c.col };
  const right = { row: c.row, col: c.col + 1 };
  const top = { row: c.row - 1, col: c.col };
  switch (c.orientation) {
    case 0: return [{ pos: bl, color: ca }, { pos: right, color: cb }];
    case 1: return [{ pos: top, color: ca }, { pos: bl, color: cb }];
    case 2: return [{ pos: right, color: ca }, { pos: bl, color: cb }];
    case 3: return [{ pos: bl, color: ca }, { pos: top, color: cb }];
  }
}

export function fits(board: Board, c: Capsule): boolean {
  return capsuleHalves(c).every(h => board.isFree(h.pos.row, h.pos.col));
}

/** Try to shift the capsule. Returns the moved capsule or null if blocked. */
export function tryMove(board: Board, c: Capsule, dRow: number, dCol: number): Capsule | null {
  const moved = { ...c, row: c.row + dRow, col: c.col + dCol };
  return fits(board, moved) ? moved : null;
}

/**
 * Rotate around the bottom-left cell. If blocked, try one cell to the left (wall kick).
 * Returns the rotated capsule or null if both fail.
 */
export function tryRotate(board: Board, c: Capsule, clockwise: boolean): Capsule | null {
  const orientation = ((c.orientation + (clockwise ? 1 : 3)) % 4) as Capsule['orientation'];
  const rotated = { ...c, orientation };
  if (fits(board, rotated)) return rotated;
  const kicked = { ...rotated, col: rotated.col - 1 };
  if (fits(board, kicked)) return kicked;
  return null;
}
