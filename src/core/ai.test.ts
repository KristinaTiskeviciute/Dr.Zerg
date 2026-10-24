import { describe, expect, it } from 'vitest';
import { CPU_SKILLS, CpuSkill } from '../config';
import { chainPotential, choosePlacement, CpuController, isPanicking, reachablePlacements } from './ai';
import { Board } from './board';
import { Capsule, capsuleHalves } from './capsule';
import { Game } from './game';
import { Rng } from './rng';
import { Color } from './types';

const { Red: R, Yellow: Y, Blue: B } = Color;
const STEP = 1000 / 60;
const PERFECT: CpuSkill = { ...CPU_SKILLS.normal, mistakeChance: 0 };

const spawn = (colors: readonly [Color, Color]): Capsule => ({ row: 0, col: 3, orientation: 0, colors });

describe('reachablePlacements', () => {
  it('finds every column and orientation on an empty board, all resting on the floor', () => {
    const b = new Board(8, 16);
    const ps = reachablePlacements(b, spawn([R, Y]));
    // 7 horizontal spots × 2 color orders + 8 vertical spots × 2 color orders
    expect(ps).toHaveLength(7 * 2 + 8 * 2);
    for (const p of ps) {
      expect(capsuleHalves(p.final).some(h => h.pos.row === 15)).toBe(true);
    }
  });

  it('dedupes single-color capsules that look the same either way round', () => {
    const ps = reachablePlacements(new Board(8, 16), spawn([B, B]));
    expect(ps).toHaveLength(7 + 8);
  });

  it("doesn't reach past a wall of blocks", () => {
    const b = new Board(8, 16);
    for (let r = 0; r < 16; r++) b.set(r, 1, { kind: 'germ', color: [R, Y, B][r % 3] });
    const ps = reachablePlacements(b, spawn([R, Y]));
    expect(ps.every(p => capsuleHalves(p.final).every(h => h.pos.col >= 2))).toBe(true);
  });
});

describe('choosePlacement', () => {
  it('takes an obvious clear', () => {
    const b = new Board(8, 16);
    b.set(15, 6, { kind: 'germ', color: R });
    b.set(14, 6, { kind: 'germ', color: R });
    b.set(15, 1, { kind: 'germ', color: Y });
    const p = choosePlacement(b, spawn([R, R]), new Rng(1), PERFECT)!;
    expect(capsuleHalves(p.final).map(h => h.pos.col)).toEqual([6, 6]);
  });

  it('prefers matching colors over burying a germ', () => {
    const b = new Board(8, 16);
    b.set(15, 0, { kind: 'germ', color: Y });
    b.set(15, 7, { kind: 'germ', color: B });
    const p = choosePlacement(b, spawn([B, B]), new Rng(1), PERFECT)!;
    const cols = capsuleHalves(p.final).map(h => h.pos.col);
    expect(cols).not.toContain(0);
    expect(cols).toContain(7);
  });
});

describe('CpuController', () => {
  function playOut(level: number, seed: number, skill: CpuSkill, maxMinutes = 15): Game {
    const g = new Game({ level, speed: 'med', seed });
    const cpu = new CpuController(skill, seed);
    for (let t = 0; t < maxMinutes * 60000 && !g.isOver; t += STEP) g.step(STEP, cpu.poll(g, STEP));
    return g;
  }

  it('beats level 0 and level 5 on its own', () => {
    let wins = 0;
    for (let seed = 1; seed <= 6; seed++) {
      if (playOut(0, seed, PERFECT).phase === 'won') wins++;
      if (playOut(5, seed + 100, PERFECT).phase === 'won') wins++;
    }
    expect(wins).toBeGreaterThanOrEqual(11); // out of 12
  }, 60_000);

  it('easy plays worse than hard', () => {
    let easyLeft = 0;
    let hardLeft = 0;
    for (let seed = 1; seed <= 4; seed++) {
      easyLeft += playOut(10, seed, CPU_SKILLS.easy, 3).germsLeft;
      hardLeft += playOut(10, seed, CPU_SKILLS.hard, 3).germsLeft;
    }
    expect(hardLeft).toBeLessThan(easyLeft);
  }, 60_000);

  it('can slide a capsule under a hanging germ', () => {
    // The last red germ hangs at row 9 in the right-hand column; the only way under it is a slide-under.
    const b = new Board(8, 16);
    b.set(9, 7, { kind: 'germ', color: R });
    for (let c = 0; c < 7; c++) b.set(15, c, { kind: 'germ', color: [Y, B][c % 2] });
    const ps = reachablePlacements(b, spawn([R, R]));
    expect(ps.some(p => capsuleHalves(p.final).some(h => h.pos.col === 7 && h.pos.row > 9))).toBe(true);
  });
});

describe('CPU attacks', () => {
  it('Hard sends garbage within its first 2.5 minutes, every game', () => {
    for (let seed = 1; seed <= 5; seed++) {
      const g = new Game({ level: 5, speed: 'med', seed });
      const cpu = new CpuController(CPU_SKILLS.hard, seed);
      let attacked = false;
      for (let t = 0; t < 150_000 && !g.isOver && !attacked; t += STEP) {
        g.step(STEP, cpu.poll(g, STEP));
        attacked = g.drainEvents().some(e => e.type === 'garbageOut');
      }
      expect(attacked, `seed ${seed}`).toBe(true);
    }
  }, 60_000);

  it('spots a chain that is ready to fire', () => {
    // Bottom row: _ R R R Y Y Y _ with a red half resting on the first yellow.
    // A yellow dropped in the right-hand column clears the yellows; the red falls next to the reds → 2 lines.
    const b = new Board(8, 16);
    for (const c of [1, 2, 3]) b.set(15, c, { kind: 'germ', color: R });
    for (const c of [4, 5, 6]) b.set(15, c, { kind: 'germ', color: Y });
    b.set(14, 4, { kind: 'pill', color: R, link: 'none' });
    expect(b.findMatches()).toHaveLength(0);
    expect(chainPotential(b)).toBe(2);
  });

  it('sees no chain on a plain board', () => {
    const b = new Board(8, 16);
    for (const c of [1, 2, 3]) b.set(15, c, { kind: 'germ', color: R });
    expect(chainPotential(b)).toBe(1);
  });
});

describe('panic mode', () => {
  it('kicks in when capsule pieces reach near the top, but not for germs', () => {
    const b = new Board(8, 16);
    b.set(3, 0, { kind: 'germ', color: R });
    expect(isPanicking(b)).toBe(false);
    b.set(4, 6, { kind: 'pill', color: B, link: 'none' });
    expect(isPanicking(b)).toBe(true);
  });

  it('in a crisis it keeps the capsule away from the spawn instead of stacking higher', () => {
    const b = new Board(8, 16);
    // Columns 2–5 stacked with junk up to row 6; the sides are empty.
    for (let r = 6; r < 16; r++) for (let c = 2; c < 6; c++) b.set(r, c, { kind: 'pill', color: [R, Y, B][(r + c) % 3], link: 'none' });
    b.set(15, 0, { kind: 'germ', color: Y });
    const prio = { attack: 120, setup: 0, height: 5 };
    const p = choosePlacement(b, spawn([B, B]), new Rng(1), PERFECT, undefined, prio)!;
    expect(capsuleHalves(p.final).every(h => h.pos.col < 2 || h.pos.col > 5)).toBe(true);
  });
});
