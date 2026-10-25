import { describe, expect, it } from 'vitest';
import { CPU_SKILLS, ROUNDS_TO_WIN } from '../config';
import { CpuController } from './ai';
import { Board } from './board';
import { GameEvent, StepInput } from './game';
import { Match } from './match';
import { Color } from './types';

const { Red: R, Yellow: Y, Blue: B } = Color;
const STEP = 1000 / 60;
const players = [{ level: 3, speed: 'med' as const }, { level: 3, speed: 'med' as const }] as [any, any];

/** p0's board: one capsule drop wins the round (two red germs under the spawn column). */
function nearWin(b: Board) {
  b.set(15, 3, { kind: 'germ', color: R });
  b.set(14, 3, { kind: 'germ', color: R });
}

function forceRedVertical(m: Match, i: 0 | 1) {
  m.games[i].active = { row: 0, col: 3, orientation: 1, colors: [R, R] };
}

function run(m: Match, inputs: [StepInput, StepInput], maxSteps = 5000): [GameEvent[], GameEvent[]] {
  const all: [GameEvent[], GameEvent[]] = [[], []];
  for (let i = 0; i < maxSteps && m.state === 'playing'; i++) {
    const [a, b] = m.step(STEP, inputs);
    all[0].push(...a);
    all[1].push(...b);
  }
  return all;
}

describe('Match', () => {
  it('gives both players the same germs and capsules at the same level', () => {
    const m = new Match({ players, seed: 9, fastGarbage: false });
    expect(m.games[0].board.cells).toEqual(m.games[1].board.cells);
    expect(m.games[0].active).toEqual(m.games[1].active);
  });

  it('uses a new seed every round, still shared by both players', () => {
    const m = new Match({ players, seed: 9, fastGarbage: false });
    const round1 = JSON.stringify(m.games[0].board.cells);
    m.state = 'roundOver';
    m.nextRound();
    expect(m.round).toBe(2);
    expect(JSON.stringify(m.games[0].board.cells)).not.toBe(round1);
    expect(m.games[0].board.cells).toEqual(m.games[1].board.cells);
  });

  it("sends one player's chain garbage to the other board", () => {
    const m = new Match({
      players, seed: 1, fastGarbage: false,
      setupBoard: (b, i) => {
        b.set(15, 7, { kind: 'germ', color: B });
        if (i === 1) return;
        b.set(15, 0, { kind: 'germ', color: R });
        b.set(15, 1, { kind: 'germ', color: R });
        b.set(15, 2, { kind: 'germ', color: R });
        for (let r = 13; r < 16; r++) b.set(r, 3, { kind: 'pill', color: Y, link: 'none' });
      },
    });
    m.games[0].active = { row: 0, col: 3, orientation: 1, colors: [R, Y] };
    const sent: GameEvent[] = [];
    for (let i = 0; i < 3000 && !sent.some(e => e.type === 'garbageOut'); i++) sent.push(...m.step(STEP, [{ softDrop: true }, {}])[0]);
    expect(sent.find(e => e.type === 'garbageOut')).toMatchObject({ type: 'garbageOut', colors: [Y, R], firstColors: [Y] });
    expect(m.games[1].pendingGarbage).toBe(2);
  });

  it(`counts round wins, keeps going at 2–0, and ends the match at ${ROUNDS_TO_WIN} wins`, () => {
    const m = new Match({ players, seed: 3, fastGarbage: false, setupBoard: (b, i) => { if (i === 0) nearWin(b); else b.set(15, 0, { kind: 'germ', color: B }); } });
    for (let w = 1; w <= ROUNDS_TO_WIN; w++) {
      if (w > 1) m.nextRound();
      forceRedVertical(m, 0);
      run(m, [{ softDrop: true }, {}]);
      expect(m.roundWinner).toBe(0);
      expect(m.wins).toEqual([w, 0]);
      expect(m.state).toBe(w < ROUNDS_TO_WIN ? 'roundOver' : 'matchOver');
    }
    expect(m.matchWinner).toBe(0);
  });

  it('topping out gives the round to the other player', () => {
    const m = new Match({
      players, seed: 4, fastGarbage: false,
      setupBoard: (b, i) => {
        b.set(15, 0, { kind: 'germ', color: B });
        if (i === 1) for (let r = 1; r < 16; r++) b.set(r, 3, { kind: 'germ', color: [R, Y, B][r % 3] });
      },
    });
    run(m, [{}, { softDrop: true }]);
    expect(m.roundWinner).toBe(0);
  });

  it('two CPUs can play a whole match, with garbage flying both ways', () => {
    const m = new Match({ players: [{ level: 4, speed: 'high' }, { level: 4, speed: 'high' }], seed: 11, fastGarbage: true });
    let garbage = 0;
    for (let round = 0; round < ROUNDS_TO_WIN * 2 - 1 && m.state !== 'matchOver'; round++) {
      if (m.state === 'roundOver') m.nextRound();
      const cpus = [new CpuController(CPU_SKILLS.hard, 1 + round), new CpuController(CPU_SKILLS.normal, 50 + round)];
      for (let i = 0; i < 20 * 60 * 60 && m.state === 'playing'; i++) {
        const ev = m.step(STEP, [cpus[0].poll(m.games[0], STEP), cpus[1].poll(m.games[1], STEP)]);
        garbage += [...ev[0], ...ev[1]].filter(e => e.type === 'garbageIn').length;
      }
    }
    expect(m.state).toBe('matchOver');
    expect(Math.max(...m.wins)).toBe(ROUNDS_TO_WIN);
    expect(garbage).toBeGreaterThan(0);
  }, 120_000);

  it('stops both boards once the round is decided', () => {
    const m = new Match({ players, seed: 3, fastGarbage: false, setupBoard: (b, i) => { if (i === 0) nearWin(b); else b.set(15, 0, { kind: 'germ', color: B }); } });
    forceRedVertical(m, 0);
    run(m, [{ softDrop: true }, {}]);
    const before = JSON.stringify(m.games[1].active);
    for (let i = 0; i < 100; i++) m.step(STEP, [{}, { softDrop: true }]);
    expect(JSON.stringify(m.games[1].active)).toBe(before);
  });
});

describe('Match with 3–4 players', () => {
  const four = [0, 1, 2, 3].map(() => ({ level: 3, speed: 'med' as const }));
  const three = four.slice(0, 3);
  /** A column of germs right under the spawn: the first capsule that locks there tops out. */
  const blockedSpawn = (b: Board) => {
    b.set(15, 0, { kind: 'germ', color: B });
    for (let r = 1; r < 16; r++) b.set(r, 3, { kind: 'germ', color: [R, Y, B][r % 3] });
  };
  const keepGoing = (b: Board) => b.set(15, 0, { kind: 'germ', color: B });

  it('targets by the color of the first clear: blue next, yellow two over, red three over', () => {
    const m = new Match({ players: four, seed: 1, fastGarbage: false });
    expect(m.targetsFor(0, [B])).toEqual([1]);
    expect(m.targetsFor(0, [Y])).toEqual([2]);
    expect(m.targetsFor(0, [R])).toEqual([3]);
    expect(m.targetsFor(2, [B])).toEqual([3]);
    expect(m.targetsFor(2, [Y])).toEqual([0]); // wraps around
    expect(m.targetsFor(0, [B, R]).sort()).toEqual([1, 3]); // two colors at once: two targets
  });

  it('skips players who are out, wrapping around the ones left', () => {
    const m = new Match({ players: four, seed: 1, fastGarbage: false, setupBoard: (b, i) => (i === 1 ? blockedSpawn(b) : keepGoing(b)) });
    for (let i = 0; i < 200 && m.isAlive(1); i++) m.step(STEP, [{}, { softDrop: true }, {}, {}]);
    expect(m.isAlive(1)).toBe(false);
    expect(m.state).toBe('playing'); // three still in
    expect(m.targetsFor(0, [B])).toEqual([2]);
    expect(m.targetsFor(0, [Y])).toEqual([3]);
    expect(m.targetsFor(0, [R])).toEqual([2]); // only two left: red wraps to the first
  });

  it('with two players garbage always goes to the other, whatever the color', () => {
    const m = new Match({ players: four.slice(0, 2), seed: 1, fastGarbage: false });
    expect(m.targetsFor(0, [Y])).toEqual([1]);
    expect(m.targetsFor(1, [R])).toEqual([0]);
  });

  it("delivers a chain's garbage to the targeted player only", () => {
    const m = new Match({
      players: three, seed: 1, fastGarbage: false,
      setupBoard: (b, i) => {
        keepGoing(b);
        if (i !== 0) return;
        // Bottom row R R Y R (cols 1–4) with yellows stacked above the Y in column 3.
        b.set(15, 1, { kind: 'germ', color: R });
        b.set(15, 2, { kind: 'germ', color: R });
        b.set(15, 4, { kind: 'germ', color: R });
        for (let r = 12; r < 16; r++) b.set(r, 3, { kind: 'pill', color: Y, link: 'none' });
      },
    });
    // The capsule's yellow lands on that column (first clear = yellow); its red falls into the gap and
    // completes the bottom row of reds (second clear).
    m.games[0].active = { row: 0, col: 3, orientation: 1, colors: [R, Y] };
    let deliveries: typeof m.deliveries = [];
    for (let i = 0; i < 3000 && deliveries.length === 0; i++) {
      m.step(STEP, [{ softDrop: true }, {}, {}]);
      deliveries = m.deliveries;
    }
    // Three players: yellow goes two over from player 0 → player 2.
    expect(deliveries).toEqual([{ from: 0, to: 2, colors: expect.any(Array) }]);
    expect(m.games[2].pendingGarbage).toBeGreaterThan(0);
    expect(m.games[1].pendingGarbage).toBe(0);
  });

  it('the last player standing wins the round', () => {
    const m = new Match({ players: three, seed: 2, fastGarbage: false, setupBoard: (b, i) => (i === 0 ? keepGoing(b) : blockedSpawn(b)) });
    for (let i = 0; i < 300 && m.state === 'playing'; i++) m.step(STEP, [{}, { softDrop: true }, { softDrop: true }]);
    expect(m.state).toBe('roundOver');
    expect(m.roundWinner).toBe(0);
    expect(m.wins).toEqual([1, 0, 0]);
  });

  it('four CPUs can play a whole match', () => {
    const m = new Match({ players: four.map(p => ({ ...p, speed: 'high' as const })), seed: 21, fastGarbage: false });
    let garbage = 0;
    for (let round = 0; round < 4 * ROUNDS_TO_WIN && m.state !== 'matchOver'; round++) {
      if (m.state === 'roundOver') m.nextRound();
      const cpus = [0, 1, 2, 3].map(i => new CpuController(CPU_SKILLS.hard, 10 * round + i));
      for (let i = 0; i < 20 * 60 * 60 && m.state === 'playing'; i++) {
        m.step(STEP, m.games.map((g, k) => cpus[k].poll(g, STEP)));
        garbage += m.deliveries.length;
      }
    }
    expect(m.state).toBe('matchOver');
    expect(Math.max(...m.wins)).toBe(ROUNDS_TO_WIN);
    expect(garbage).toBeGreaterThan(0);
  }, 240_000);
});
