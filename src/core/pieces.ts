import { Rng } from './rng';
import { Color } from './types';

const { Red: R, Yellow: Y, Blue: B } = Color;

/** The 9 capsule colorings (IDs 0–8), as [left, right] when spawned horizontally. */
export const PILLS: readonly (readonly [Color, Color])[] = [
  [Y, Y], [Y, R], [Y, B],
  [R, Y], [R, R], [R, B],
  [B, Y], [B, R], [B, B],
];

/**
 * Capsule sequence, classic style: each pill ID is the previous ID plus a random
 * 0–15, wrapped into 0–8. Two players with the same seed get the same sequence.
 */
export class PieceSequence {
  private readonly rng: Rng;
  private readonly ids: number[] = [];
  private lastId: number;

  constructor(seed: number) {
    this.rng = new Rng(seed);
    this.lastId = this.rng.int(PILLS.length);
  }

  /** Pill ID at position i (0-based) in the sequence. */
  idAt(i: number): number {
    while (this.ids.length <= i) {
      this.lastId = (this.lastId + this.rng.int(16)) % PILLS.length;
      this.ids.push(this.lastId);
    }
    return this.ids[i];
  }

  colorsAt(i: number): readonly [Color, Color] {
    return PILLS[this.idAt(i)];
  }
}
