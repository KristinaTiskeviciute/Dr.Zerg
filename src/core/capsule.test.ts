import { describe, expect, it } from 'vitest';
import { Board } from './board';
import { Capsule, capsuleHalves, tryRotate } from './capsule';
import { Color } from './types';

const { Red: R, Blue: B } = Color;

const cap = (row: number, col: number, orientation: Capsule['orientation'] = 0): Capsule => ({
  row, col, orientation, colors: [R, B],
});

describe('rotation', () => {
  it('rotates horizontal to vertical around the left half', () => {
    const b = new Board(8, 16);
    const r = tryRotate(b, cap(8, 3), true)!;
    const [a, bb] = capsuleHalves(r);
    expect(a.pos).toEqual({ row: 7, col: 3 }); // red on top (clockwise)
    expect(bb.pos).toEqual({ row: 8, col: 3 });
  });

  it('four clockwise rotations return to the start', () => {
    const b = new Board(8, 16);
    let c = cap(8, 3);
    for (let i = 0; i < 4; i++) c = tryRotate(b, c, true)!;
    expect(c).toEqual(cap(8, 3));
  });

  it('wall-kicks left when rotating to horizontal against the right wall', () => {
    const b = new Board(8, 16);
    const r = tryRotate(b, cap(8, 7, 1), true)!;
    expect(r.col).toBe(6);
    expect(r.orientation).toBe(2);
  });

  it('wall-kicks left when a block is in the way', () => {
    const b = new Board(8, 16);
    b.set(8, 4, { kind: 'germ', color: R });
    const r = tryRotate(b, cap(8, 3, 1), false)!;
    expect(r.col).toBe(2);
  });

  it('fails when both the rotation and the kick are blocked', () => {
    const b = new Board(8, 16);
    b.set(8, 4, { kind: 'germ', color: R });
    b.set(8, 2, { kind: 'germ', color: R });
    expect(tryRotate(b, cap(8, 3, 1), true)).toBeNull();
  });

  it('can rotate at the top row (top half goes above the bottle)', () => {
    const b = new Board(8, 16);
    expect(tryRotate(b, cap(0, 3), true)).not.toBeNull();
  });
});
