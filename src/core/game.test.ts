import { describe, expect, it } from 'vitest';
import { LOCK_DELAY_MS } from '../config';
import { Board } from './board';
import { fits } from './capsule';
import { pickGarbageColumns, garbageForChain } from './garbage';
import { Game, GameEvent, GameOptions } from './game';
import { Rng } from './rng';
import { Color } from './types';

const { Red: R, Yellow: Y, Blue: B } = Color;
const STEP = 1000 / 60;

/** Run the game until it's waiting for a new capsule (or over), collecting events. */
function runUntilFalling(g: Game, maxMs = 20000): GameEvent[] {
  const events: GameEvent[] = [];
  for (let t = 0; t < maxMs; t += STEP) {
    g.step(STEP);
    events.push(...g.drainEvents());
    if (g.phase === 'falling' || g.isOver) break;
  }
  return events;
}

/** Soft-drop the current capsule until it locks. */
function dropCapsule(g: Game): GameEvent[] {
  const events: GameEvent[] = [];
  const start = g.pieceIndex;
  for (let i = 0; i < 5000 && g.pieceIndex === start && !g.isOver; i++) {
    g.step(STEP, { softDrop: true });
    events.push(...g.drainEvents());
  }
  return events;
}

function game(setupBoard: (b: Board) => void, extra: Partial<GameOptions> = {}): Game {
  return new Game({ level: 0, speed: 'med', seed: 1, setupBoard, ...extra });
}

describe('Game', () => {
  it('same seed and level → same germs and capsules', () => {
    const a = new Game({ level: 10, speed: 'med', seed: 777 });
    const b = new Game({ level: 10, speed: 'med', seed: 777 });
    expect(a.board.cells).toEqual(b.board.cells);
    expect(a.active).toEqual(b.active);
    expect(a.nextColors).toEqual(b.nextColors);
  });

  it('garbage received does not change the capsule sequence', () => {
    const plain = game(b => b.set(15, 0, { kind: 'germ', color: R }), { seed: 5 });
    const hit = game(b => b.set(15, 0, { kind: 'germ', color: R }), { seed: 5 });
    hit.receiveGarbage([Y, B]);
    const seqA: unknown[] = [];
    const seqB: unknown[] = [];
    for (let i = 0; i < 4; i++) {
      seqA.push(plain.active!.colors);
      seqB.push(hit.active!.colors);
      dropCapsule(plain); runUntilFalling(plain);
      dropCapsule(hit); runUntilFalling(hit);
    }
    expect(seqB).toEqual(seqA);
  });

  it('locks after the lock delay when landed', () => {
    const g = game(b => b.set(15, 0, { kind: 'germ', color: R }));
    for (let i = 0; i < 2000 && g.pieceIndex === 0; i++) g.step(STEP);
    expect(g.pieceIndex).toBe(1);
    // Landing alone doesn't lock instantly
    const g2 = game(b => b.set(15, 0, { kind: 'germ', color: R }));
    g2.active = { ...g2.active!, row: 15 };
    g2.step(STEP);
    expect(g2.pieceIndex).toBe(0);
    for (let t = 0; t < LOCK_DELAY_MS + STEP; t += STEP) g2.step(STEP);
    expect(g2.pieceIndex).toBe(1);
  });

  it('loses when the spawn cells are blocked', () => {
    const g = game(b => {
      b.set(15, 0, { kind: 'germ', color: R });
      for (let r = 1; r < 16; r++) b.set(r, 3, { kind: 'germ', color: [R, Y, B][r % 3] });
    });
    const events = [...dropCapsule(g), ...runUntilFalling(g)];
    expect(g.phase).toBe('lost');
    expect(events.some(e => e.type === 'lost')).toBe(true);
  });

  it('wins when the last germ is cleared', () => {
    const g = game(b => {
      b.set(15, 3, { kind: 'germ', color: R });
      b.set(14, 3, { kind: 'germ', color: R });
    });
    g.active = { row: 0, col: 3, orientation: 1, colors: [R, R] };
    const events = [...dropCapsule(g), ...runUntilFalling(g)];
    expect(g.phase).toBe('won');
    expect(events.some(e => e.type === 'won')).toBe(true);
  });

  it('a chain of 2 sends 2 garbage pieces with the cleared colors', () => {
    const g = game(b => {
      b.set(15, 7, { kind: 'germ', color: B }); // keeps the round going
      // Bottom row: R R R _ ; column 3 holds three yellow singles.
      b.set(15, 0, { kind: 'germ', color: R });
      b.set(15, 1, { kind: 'germ', color: R });
      b.set(15, 2, { kind: 'germ', color: R });
      for (let r = 13; r < 16; r++) b.set(r, 3, { kind: 'pill', color: Y, link: 'none' });
    });
    // Vertical capsule, red on top of yellow, dropped onto column 3:
    // yellows clear (4 tall), then the red falls into the gap and completes the bottom row.
    g.active = { row: 0, col: 3, orientation: 1, colors: [R, Y] };
    const events = [...dropCapsule(g), ...runUntilFalling(g)];
    const clears = events.filter(e => e.type === 'clear');
    expect(clears.map(e => e.type === 'clear' && e.chain)).toEqual([1, 2]);
    const out = events.find(e => e.type === 'garbageOut');
    expect(out).toMatchObject({ type: 'garbageOut', colors: [Y, R], firstColors: [Y] });
  });

  it('the preview always shows the capsule that actually spawns next, even during clears', () => {
    const g = game(b => {
      b.set(15, 7, { kind: 'germ', color: B });
      b.set(15, 3, { kind: 'germ', color: R });
      b.set(14, 3, { kind: 'germ', color: R });
    });
    g.active = { row: 0, col: 3, orientation: 1, colors: [R, R] }; // will clear on landing
    const previews = new Set<string>();
    for (let i = 0; i < 5000 && g.pieceIndex === 0; i++) g.step(STEP, { softDrop: true });
    expect(g.phase).toBe('clearing');
    while (g.phase !== 'falling') {
      previews.add(JSON.stringify(g.nextColors));
      g.step(STEP);
    }
    expect([...previews]).toEqual([JSON.stringify(g.active!.colors)]);
  });

  it('a new capsule hangs at the top for a moment, but can be rotated and moved right away', () => {
    const g = game(b => b.set(15, 7, { kind: 'germ', color: B }));
    dropCapsule(g);
    runUntilFalling(g);
    expect(g.active!.row).toBe(0);
    g.step(STEP, { rotateCW: true });
    expect(g.active!.orientation).toBe(1); // rotated in the top row (top half up in the neck)
    g.step(STEP, { left: true });
    expect(g.active!.col).toBe(2);
    for (let t = 0; t < 300; t += STEP) g.step(STEP);
    expect(g.active!.row).toBe(0); // still hanging
    for (let t = 0; t < 1000; t += STEP) g.step(STEP);
    expect(g.active!.row).toBeGreaterThan(0); // gravity took over
  });

  it('soft drop skips the hang at the top', () => {
    const g = game(b => b.set(15, 7, { kind: 'germ', color: B }));
    dropCapsule(g);
    runUntilFalling(g);
    for (let t = 0; t < 100; t += STEP) g.step(STEP, { softDrop: true });
    expect(g.active!.row).toBeGreaterThan(0);
  });

  describe('locking with a half up in the neck', () => {
    // A column under the neck full to the top: germs (no matches) from row 4 down, three red halves in rows 1–3.
    const packed = (b: Board) => {
      b.set(15, 0, { kind: 'germ', color: B });
      for (let r = 4; r < 16; r++) b.set(r, 5, { kind: 'germ', color: [R, Y, B][r % 3] });
      for (const r of [1, 2, 3]) b.set(r, 5, { kind: 'pill', color: R, link: 'none' });
    };

    it('keeps playing if the lower half clears a line: the top half drops in', () => {
      const g = game(packed);
      // Vertical capsule there: red bottom at row 0 (makes 4 reds), yellow top up in the neck.
      g.active = { row: 0, col: 5, orientation: 1, colors: [Y, R] };
      const events = [...dropCapsule(g), ...runUntilFalling(g)];
      expect(events.some(e => e.type === 'clear')).toBe(true);
      expect(g.phase).toBe('falling');
      expect(g.board.get(3, 5)).toMatchObject({ kind: 'pill', color: Y }); // dropped in and fell into the gap
    });

    it('tops out if nothing clears to make room', () => {
      const g = game(packed);
      g.active = { row: 0, col: 5, orientation: 1, colors: [Y, B] }; // blue doesn't match the reds
      [...dropCapsule(g), ...runUntilFalling(g)];
      expect(g.phase).toBe('lost');
    });
  });

  describe('the bottle is closed over the shoulders', () => {
    it('a half can stick up only under the neck (columns 2–5)', () => {
      const board = new Board(8, 16);
      const standing = (col: number) => fits(board, { row: 0, col, orientation: 1, colors: [R, B] });
      expect([0, 1, 2, 3, 4, 5, 6, 7].map(standing)).toEqual([false, false, true, true, true, true, false, false]);
    });

    it("a tower at the side with one space left doesn't let a standing capsule stick up over it", () => {
      // Right-hand column full except the top row.
      const g = game(b => {
        b.set(15, 0, { kind: 'germ', color: B });
        for (let r = 1; r < 16; r++) b.set(r, 7, { kind: 'germ', color: [R, Y, B][r % 3] });
      });
      runUntilFalling(g);
      g.step(STEP, { rotateCW: true }); // standing, top half up in the neck
      for (let i = 0; i < 6; i++) g.step(STEP, { right: true });
      expect(g.active!.col).toBe(5); // stops at the edge of the neck: can't reach the gap at column 7
      expect(g.phase).toBe('falling');
    });
  });

  it('speeds up every 10 capsules and says so', () => {
    const g = game(b => b.set(15, 7, { kind: 'germ', color: B }));
    const start = g.fallIntervalMs();
    const ups: number[] = [];
    for (let i = 0; i < 20; i++) {
      // Spread over four columns so the stacks don't top out.
      g.active = { row: 0, col: [0, 2, 5, 7][i % 4], orientation: 1, colors: [i % 3, (i + 1) % 3] as [Color, Color] };
      for (const e of [...dropCapsule(g), ...runUntilFalling(g)]) if (e.type === 'speedUp') ups.push(e.step);
      if (g.isOver) break;
    }
    expect(ups.slice(0, 2)).toEqual([1, 2]);
    expect(g.fallIntervalMs()).toBeLessThan(start * 0.9);
  });

  it('a single clear sends no garbage', () => {
    expect(garbageForChain([R])).toEqual([]);
    expect(garbageForChain([R, Y])).toEqual([R, Y]);
    expect(garbageForChain([R, Y, B, R, Y])).toHaveLength(4);
  });

  it('incoming garbage waits until the capsule locks, then lands', () => {
    const g = game(b => b.set(15, 7, { kind: 'germ', color: B }));
    g.receiveGarbage([R, Y, B]);
    g.step(STEP);
    expect(g.phase).toBe('falling');
    expect(g.board.cells.filter(c => c?.kind === 'pill')).toHaveLength(0);
    const events = [...dropCapsule(g), ...runUntilFalling(g)];
    expect(events.some(e => e.type === 'garbageIn')).toBe(true);
    expect(events.some(e => e.type === 'garbageLanded')).toBe(true);
    expect(g.board.cells.filter(c => c?.kind === 'pill' && c.link === 'none')).toHaveLength(3);
  });

  it('clears caused by garbage do not send garbage back', () => {
    const g = game(b => {
      b.set(15, 7, { kind: 'germ', color: B });
      // Three reds stacked in columns 0–2 and 4–6 (no horizontal run of 4), so a red garbage
      // piece landing there completes a vertical 4. Any 3 non-adjacent columns hit at least one.
      for (const c of [0, 1, 2, 4, 5, 6]) for (let r = 13; r < 16; r++) b.set(r, c, { kind: 'germ', color: R });
    });
    g.active = { row: 0, col: 7, orientation: 1, colors: [Y, B] };
    g.receiveGarbage([R, R, R]);
    const events = [...dropCapsule(g), ...runUntilFalling(g)];
    expect(events.some(e => e.type === 'clear')).toBe(true);
    expect(events.some(e => e.type === 'garbageOut')).toBe(false);
  });

  it('fast garbage falls faster only when enabled and Down is held', () => {
    const timeToLand = (fastGarbage: boolean, hold: boolean) => {
      const g = game(b => b.set(15, 7, { kind: 'germ', color: B }), { fastGarbage });
      g.active = { row: 0, col: 6, orientation: 1, colors: [Y, R] };
      g.receiveGarbage([R]);
      dropCapsule(g);
      let t = 0;
      while (g.phase !== 'garbage' && t < 5000) { g.step(STEP); t += STEP; }
      let fall = 0;
      while (g.phase === 'garbage' && fall < 10000) { g.step(STEP, { softDrop: hold }); fall += STEP; }
      return fall;
    };
    const normal = timeToLand(false, true);
    const fast = timeToLand(true, true);
    const onButNotHeld = timeToLand(true, false);
    expect(fast).toBeLessThan(normal / 2);
    expect(onButNotHeld).toBeCloseTo(normal, -2);
  });

  it('with fast garbage on, holding Down also speeds up loose halves falling after a clear', () => {
    const timeToSettle = (fastGarbage: boolean, hold: boolean) => {
      const g = game(b => {
        b.set(15, 7, { kind: 'germ', color: B });
        // Column 0: a red germ with two red singles on it. A red-bottom capsule completes the 4;
        // its yellow top half is left over and falls 4 rows.
        b.set(15, 0, { kind: 'germ', color: R });
        b.set(14, 0, { kind: 'pill', color: R, link: 'none' });
        b.set(13, 0, { kind: 'pill', color: R, link: 'none' });
      }, { fastGarbage });
      g.active = { row: 0, col: 0, orientation: 1, colors: [Y, R] };
      dropCapsule(g);
      while (g.phase !== 'settling') g.step(STEP);
      let fall = 0;
      while (g.phase === 'settling' && fall < 10000) { g.step(STEP, { softDrop: hold }); fall += STEP; }
      expect(g.board.get(15, 0)).toMatchObject({ color: Y });
      return fall;
    };
    const normal = timeToSettle(false, true);
    expect(timeToSettle(true, true)).toBeLessThan(normal / 2);
    expect(timeToSettle(true, false)).toBeCloseTo(normal, -2);
  });
});

describe('pickGarbageColumns', () => {
  it('picks distinct, non-adjacent, open columns', () => {
    const rng = new Rng(1);
    for (let i = 0; i < 200; i++) {
      const b = new Board(8, 16);
      const cols = pickGarbageColumns(b, 4, rng);
      expect(cols).toHaveLength(4);
      for (let k = 1; k < cols.length; k++) expect(cols[k] - cols[k - 1]).toBeGreaterThanOrEqual(2);
    }
  });

  it('skips columns whose top cell is full', () => {
    const b = new Board(8, 16);
    for (const c of [0, 2, 4, 6]) b.set(0, c, { kind: 'germ', color: R });
    const cols = pickGarbageColumns(b, 4, new Rng(3));
    expect(cols.every(c => c % 2 === 1)).toBe(true);
  });
});
