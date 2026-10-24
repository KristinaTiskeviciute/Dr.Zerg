import { describe, expect, it } from 'vitest';
import { Color } from '../core/types';
import { germFrame, Grid, PILL_HALF, PILL_SINGLE, pillGrid, rotate, shade, SPRITE_SIZE } from './sprites';

const ALLOWED = /^[.obWkm]+$/;

function checkGrid(name: string, g: Grid) {
  expect(g.length, name).toBe(SPRITE_SIZE);
  g.forEach((row, i) => {
    expect(row.length, `${name} row ${i}`).toBe(SPRITE_SIZE);
    expect(row, `${name} row ${i}`).toMatch(ALLOWED);
  });
}

describe('sprites', () => {
  it('all grids are 16×16 with known characters', () => {
    checkGrid('pill half', PILL_HALF);
    checkGrid('pill single', PILL_SINGLE);
    for (const c of [Color.Red, Color.Yellow, Color.Blue]) {
      checkGrid(`germ ${c} a`, germFrame(c, 0));
      checkGrid(`germ ${c} b`, germFrame(c, 1));
    }
  });

  it('rotating four times is the identity', () => {
    expect(rotate(PILL_HALF, 4)).toEqual(PILL_HALF);
  });

  it('each linked half is flat (body to the edge) on the partner side', () => {
    expect(pillGrid('right')[8][15]).toBe('b');
    expect(pillGrid('left')[8][0]).toBe('b');
    expect(pillGrid('down')[15][8]).toBe('b');
    expect(pillGrid('up')[0][8]).toBe('b');
  });

  it('shading only changes body pixels', () => {
    const s = shade(PILL_SINGLE, true);
    for (let y = 0; y < 16; y++) {
      for (let x = 0; x < 16; x++) {
        if (PILL_SINGLE[y][x] !== 'b') expect(s[y][x]).toBe(PILL_SINGLE[y][x]);
      }
    }
    expect(s.join('')).toContain('w');
  });
});
