import { describe, expect, it } from 'vitest';
import { Board } from './board';
import { Cell, Color } from './types';

const { Red: R, Yellow: Y, Blue: B } = Color;

const germ = (color: Color): Cell => ({ kind: 'germ', color });
const single = (color: Color): Cell => ({ kind: 'pill', color, link: 'none' });

function board(): Board {
  return new Board(8, 16);
}

describe('findMatches', () => {
  it('finds 4 in a row horizontally, germs included', () => {
    const b = board();
    b.set(15, 0, germ(R));
    b.set(15, 1, single(R));
    b.set(15, 2, single(R));
    b.set(15, 3, germ(R));
    const m = b.findMatches();
    expect(m).toHaveLength(1);
    expect(m[0].color).toBe(R);
    expect(m[0].cells).toHaveLength(4);
  });

  it('finds vertical matches and ignores 3 in a row', () => {
    const b = board();
    for (let r = 12; r < 16; r++) b.set(r, 5, single(B));
    b.set(15, 0, single(Y));
    b.set(15, 1, single(Y));
    b.set(15, 2, single(Y));
    const m = b.findMatches();
    expect(m).toHaveLength(1);
    expect(m[0].cells.every(p => p.col === 5)).toBe(true);
  });

  it('counts a cross as two lines', () => {
    const b = board();
    for (let c = 2; c < 6; c++) b.set(15, c, single(R));
    for (let r = 12; r < 15; r++) b.set(r, 3, single(R));
    expect(b.findMatches()).toHaveLength(2);
  });

  it('treats a run of 5 as one line', () => {
    const b = board();
    for (let c = 0; c < 5; c++) b.set(15, c, single(Y));
    const m = b.findMatches();
    expect(m).toHaveLength(1);
    expect(m[0].cells).toHaveLength(5);
  });
});

describe('clear and gravity', () => {
  it('turns a half into a single when its partner clears, and it falls on its own', () => {
    const b = board();
    // Horizontal capsule on row 10: left half red, right half blue.
    b.placeCapsule({ row: 10, col: 0 }, R, { row: 10, col: 1 }, B);
    // Support under the blue half only.
    b.set(11, 1, germ(Y));
    b.clear([{ row: 10, col: 1 }]);
    expect(b.get(10, 0)).toEqual(single(R));
    while (b.gravityStep());
    expect(b.get(15, 0)).toEqual(single(R));
  });

  it('keeps a horizontal capsule together and supported by either half', () => {
    const b = board();
    b.placeCapsule({ row: 5, col: 2 }, R, { row: 5, col: 3 }, Y);
    b.set(6, 3, germ(B));
    expect(b.gravityStep()).toBe(false);
    expect(b.get(5, 2)?.kind).toBe('pill');
  });

  it('drops a vertical capsule as a unit', () => {
    const b = board();
    b.placeCapsule({ row: 5, col: 4 }, R, { row: 4, col: 4 }, Y); // R bottom, Y top
    while (b.gravityStep());
    expect(b.get(15, 4)).toMatchObject({ color: R, link: 'up' });
    expect(b.get(14, 4)).toMatchObject({ color: Y, link: 'down' });
  });

  it('never moves germs', () => {
    const b = board();
    b.set(3, 3, germ(B));
    expect(b.gravityStep()).toBe(false);
    expect(b.get(3, 3)).toEqual(germ(B));
  });

  it('a stack of singles falls together, one row per step', () => {
    const b = board();
    b.set(10, 0, single(R));
    b.set(11, 0, single(Y));
    b.gravityStep();
    expect(b.get(11, 0)).toEqual(single(R));
    expect(b.get(12, 0)).toEqual(single(Y));
  });

  it('falling halves can form a new match (chain)', () => {
    const b = board();
    // Bottom row: three reds with a gap at col 3.
    b.set(15, 0, germ(R));
    b.set(15, 1, germ(R));
    b.set(15, 2, germ(R));
    b.set(15, 4, germ(Y));
    // A red single sitting on a yellow vertical line that will clear.
    for (let r = 11; r < 15; r++) b.set(r, 3, single(Y));
    b.set(10, 3, single(R));
    const first = b.findMatches();
    expect(first).toHaveLength(1);
    b.clear(first[0].cells);
    while (b.gravityStep());
    const second = b.findMatches();
    expect(second).toHaveLength(1);
    expect(second[0].color).toBe(R);
  });
});
