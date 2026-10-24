import { describe, expect, it } from 'vitest';
import { germMaxRows, MAX_LEVEL } from '../config';
import { Board } from './board';
import { germCountForLevel, placeGerms } from './germs';
import { Rng } from './rng';

function generate(level: number, seed: number): Board {
  const b = new Board(8, 16);
  placeGerms(b, level, new Rng(seed));
  return b;
}

describe('placeGerms', () => {
  it('places (level + 1) * 4 germs at every level, for many seeds', () => {
    for (let level = 0; level <= MAX_LEVEL; level++) {
      for (let seed = 1; seed <= 50; seed++) {
        expect(generate(level, seed).germCount(), `level ${level} seed ${seed}`).toBe(germCountForLevel(level));
      }
    }
    expect(germCountForLevel(20)).toBe(84);
  });

  it('respects the per-level height limit', () => {
    for (let level = 0; level <= MAX_LEVEL; level++) {
      const b = generate(level, level + 100);
      const topAllowed = 16 - germMaxRows(level);
      for (let r = 0; r < topAllowed; r++) {
        for (let c = 0; c < 8; c++) expect(b.get(r, c)).toBeNull();
      }
    }
  });

  it('never puts the same color exactly two cells apart (so no 3-in-a-row either)', () => {
    for (let level = 0; level <= MAX_LEVEL; level++) {
      for (let seed = 1; seed <= 30; seed++) {
        const b = generate(level, seed * 7919);
        for (let r = 0; r < 16; r++) {
          for (let c = 0; c < 8; c++) {
            const cell = b.get(r, c);
            if (!cell) continue;
            expect(b.get(r, c + 2)?.color === cell.color, `h ${level}/${seed} @${r},${c}`).toBe(false);
            expect(b.get(r + 2, c)?.color === cell.color, `v ${level}/${seed} @${r},${c}`).toBe(false);
          }
        }
        expect(b.findMatches(3)).toHaveLength(0);
      }
    }
  });

  it('is identical for the same seed', () => {
    expect(generate(15, 4242).cells).toEqual(generate(15, 4242).cells);
  });
});
