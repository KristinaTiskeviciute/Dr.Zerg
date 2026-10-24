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
    expect(sent.find(e => e.type === 'garbageOut')).toEqual({ type: 'garbageOut', colors: [Y, R] });
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
