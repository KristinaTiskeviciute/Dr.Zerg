import { Color, Link } from '../core/types';

/**
 * 16×16 pixel sprites drawn as text grids. Characters:
 *   .  transparent     o  outline     b  body (shaded automatically)
 *   W  eye white       k  pupil       m  mouth
 * Rim light ('l'), bottom shade ('d') and the capsule glint ('w') are added in code
 * so they stay consistent when a sprite is rotated.
 */
export type Grid = readonly string[];

export const SPRITE_SIZE = 16;

/** Capsule half whose partner is to the right (flat right edge). Rotated for other links. */
export const PILL_HALF: Grid = [
  '................',
  '....oooooooooooo',
  '..oobbbbbbbbbbbb',
  '.obbbbbbbbbbbbbb',
  '.obbbbbbbbbbbbbb',
  'obbbbbbbbbbbbbbb',
  'obbbbbbbbbbbbbbb',
  'obbbbbbbbbbbbbbb',
  'obbbbbbbbbbbbbbb',
  'obbbbbbbbbbbbbbb',
  'obbbbbbbbbbbbbbb',
  '.obbbbbbbbbbbbbb',
  '.obbbbbbbbbbbbbb',
  '..oobbbbbbbbbbbb',
  '....oooooooooooo',
  '................',
];

/** A lone half (partner cleared, or garbage). */
export const PILL_SINGLE: Grid = [
  '................',
  '.....oooooo.....',
  '...oobbbbbboo...',
  '..obbbbbbbbbbo..',
  '.obbbbbbbbbbbbo.',
  '.obbbbbbbbbbbbo.',
  'obbbbbbbbbbbbbbo',
  'obbbbbbbbbbbbbbo',
  'obbbbbbbbbbbbbbo',
  'obbbbbbbbbbbbbbo',
  '.obbbbbbbbbbbbo.',
  '.obbbbbbbbbbbbo.',
  '..obbbbbbbbbbo..',
  '...oobbbbbboo...',
  '.....oooooo.....',
  '................',
];

interface GermSprite {
  a: Grid;
  /** Second wiggle frame: only the rows that differ from frame a. */
  b: Record<number, string>;
}

/** Red "Spike": horns and a toothy grin. */
const SPIKE: GermSprite = {
  a: [
    '................',
    '..o..........o..',
    '..oo........oo..',
    '..obo......obo..',
    '..obboooooobbo..',
    '.obbbbbbbbbbbbo.',
    '.oboobbbbbboobo.',
    'obbWWWbbbbWWWbbo',
    'obbWkWbbbbWkWbbo',
    'obbbbbbbbbbbbbbo',
    'obbbmmmmmmmmbbbo',
    'obbbmWmWWmWmbbbo',
    '.obbbmmmmmmbbbo.',
    '.obbbbbbbbbbbbo.',
    '..obbo.oo.obbo..',
    '...oo......oo...',
  ],
  b: {
    1: '.o............o.',
    8: 'obbWWkbbbbWWkbbo',
    10: 'obbbbmmmmmmbbbbo',
    11: 'obbbbmWWWWmbbbbo',
    12: '.obbbbmmmmbbbbo.',
    15: '....oo....oo....',
  },
};

/** Yellow "Buzz": round, with a bobbing antenna. */
const BUZZ: GermSprite = {
  a: [
    '.......oo.......',
    '......obbo......',
    '.......oo.......',
    '.......o........',
    '.....oooooo.....',
    '...oobbbbbboo...',
    '..obbbbbbbbbbo..',
    '.obbWWbbbbWWbbo.',
    '.obbWkbbbbWkbbo.',
    'obbbWWbbbbWWbbbo',
    'obbbbbbbbbbbbbbo',
    'obbbbmbbbbmbbbbo',
    '.obbbbmmmmbbbbo.',
    '.obbbbbbbbbbbbo.',
    '..oobbbbbbbboo..',
    '....oooooooo....',
  ],
  b: {
    0: '........oo......',
    1: '.......obbo.....',
    2: '........oo......',
    8: '.obbkWbbbbkWbbo.',
    11: 'obbbbbmmmmbbbbbo',
    12: '.obbbbbmmbbbbbo.',
  },
};

/** Blue "Peep": three eyes and wiggly little tentacles. */
const PEEP: GermSprite = {
  a: [
    '................',
    '................',
    '.....oooooo.....',
    '...oobbbbbboo...',
    '..obbbbbbbbbbo..',
    '.obbbbbWWbbbbbo.',
    '.obbbbbkWbbbbbo.',
    'obbWWbbbbbbWWbbo',
    'obbWkbbbbbbWkbbo',
    'obbbbbbbbbbbbbbo',
    'obbbbbmmmmbbbbbo',
    'obbbbbbmmbbbbbbo',
    'obbbbbbbbbbbbbbo',
    'obbobbobbobbobbo',
    '.o..o..o..o..o..',
    '................',
  ],
  b: {
    6: '.obbbbbWkbbbbbo.',
    8: 'obbkWbbbbbbkWbbo',
    13: 'obbbobbobbobbobo',
    14: '..o..o..o..o..o.',
  },
};

export const GERM_SPRITES: Record<Color, GermSprite> = {
  [Color.Red]: SPIKE,
  [Color.Yellow]: BUZZ,
  [Color.Blue]: PEEP,
};

export function germFrame(color: Color, frame: number): Grid {
  const s = GERM_SPRITES[color];
  if (!frame) return s.a;
  return s.a.map((row, i) => s.b[i] ?? row);
}

// --- Grid transforms ---

/** Rotate 90° clockwise `turns` times. */
export function rotate(grid: Grid, turns: number): Grid {
  let g = grid;
  for (let t = 0; t < ((turns % 4) + 4) % 4; t++) {
    const n = g.length;
    g = Array.from({ length: n }, (_, y) => Array.from({ length: n }, (_, x) => g[n - 1 - x][y]).join(''));
  }
  return g;
}

export function pillGrid(link: Link): Grid {
  switch (link) {
    case 'right': return PILL_HALF;
    case 'down': return rotate(PILL_HALF, 1);
    case 'left': return rotate(PILL_HALF, 2);
    case 'up': return rotate(PILL_HALF, 3);
    default: return PILL_SINGLE;
  }
}

/** Add rim light on top edges and shade on bottom edges of the body; optionally a glint. */
export function shade(grid: Grid, glint: boolean): Grid {
  const n = grid.length;
  const isBody = (x: number, y: number) => y < 0 || y >= n || grid[y][x] === 'b';
  const out = grid.map(row => row.split(''));
  for (let y = 0; y < n; y++) {
    for (let x = 0; x < n; x++) {
      if (grid[y][x] !== 'b') continue;
      if (!isBody(x, y - 1)) out[y][x] = 'l';
      else if (!isBody(x, y + 1)) out[y][x] = 'd';
    }
  }
  if (glint) {
    // Two white pixels just inside the top-left of the body.
    outer: for (let y = 0; y < n; y++) {
      for (let x = 0; x < n; x++) {
        if (out[y][x] === 'b' && out[y][x + 1] === 'b') {
          out[y][x + 1] = 'w';
          out[y + 1][x + 1] = 'w';
          out[y][x + 2] = 'w';
          break outer;
        }
      }
    }
  }
  return out.map(r => r.join(''));
}
