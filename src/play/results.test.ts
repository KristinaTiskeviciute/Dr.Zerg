import { describe, expect, it } from 'vitest';
import { Match } from '../core/match';
import { RoundResult } from '../net/protocol';
import { cpuRoundText, localRoundText, onlineRoundText } from './results';

/** Just the parts of a match the result text reads. */
function match(o: { phases: string[]; winner: number | null; wins: number[]; round?: number; matchWinner?: number }): Match {
  return {
    playerCount: o.phases.length,
    games: o.phases.map(phase => ({ phase })),
    roundWinner: o.winner,
    wins: o.wins,
    round: o.round ?? 1,
    state: o.matchWinner === undefined ? 'roundOver' : 'matchOver',
    matchWinner: o.matchWinner ?? null,
  } as unknown as Match;
}

describe('cpuRoundText', () => {
  it('one CPU: you cleared your bottle', () => {
    expect(cpuRoundText(match({ phases: ['won', 'playing'], winner: 0, wins: [1, 0] }), ['You', 'CPU'])).toEqual({
      title: 'You take round 1', sub: 'You cleared your bottle. You 1 – 0 CPU',
    });
  });

  it('one CPU: you topped out, the CPU wins the match', () => {
    expect(cpuRoundText(match({ phases: ['lost', 'playing'], winner: 1, wins: [1, 2], round: 3, matchWinner: 1 }), ['You', 'CPU'])).toEqual({
      title: 'The CPU wins the match', sub: 'You topped out. You 1 – 2 CPU',
    });
  });

  it('several CPUs: by name, last one standing', () => {
    const names = ['You', 'Spike', 'Blob', 'Zap'];
    expect(cpuRoundText(match({ phases: ['lost', 'playing', 'lost', 'lost'], winner: 1, wins: [0, 1, 0, 0], round: 2 }), names)).toEqual({
      title: 'Spike takes round 2', sub: 'Spike is the last one standing. You 0 · Spike 1 · Blob 0 · Zap 0',
    });
  });

  it('a draw shows just the score', () => {
    expect(cpuRoundText(match({ phases: ['lost', 'lost'], winner: null, wins: [0, 0] }), ['You', 'CPU'])).toEqual({
      title: 'Draw!', sub: 'You 0 – 0 CPU',
    });
  });
});

describe('localRoundText', () => {
  it('two players by name', () => {
    expect(localRoundText(match({ phases: ['playing', 'lost'], winner: 0, wins: [2, 1], round: 3, matchWinner: 0 }), ['P1', 'P2'])).toEqual({
      title: 'P1 wins the match!', sub: 'P2 topped out. P1 2 – 1 P2',
    });
  });

  it('three players: cleared their bottle', () => {
    expect(localRoundText(match({ phases: ['playing', 'won', 'playing'], winner: 1, wins: [0, 1, 0] }), ['P1', 'P2', 'Spike'])).toEqual({
      title: 'P2 takes round 1', sub: 'P2 cleared their bottle. P1 0 · P2 1 · Spike 0',
    });
  });
});

describe('onlineRoundText', () => {
  const result = (o: Partial<RoundResult>): RoundResult => ({
    winner: 'me', reason: 'cleared', by: 'me', wins: { me: 1, a: 0 }, matchOver: false, nextInMs: 6000, ...o,
  });

  it('one opponent: you cleared your bottle, next round coming', () => {
    expect(onlineRoundText(result({}), 'me', [{ id: 'a', name: 'Kat' }], 1)).toEqual({
      title: 'You take round 1', sub: 'You cleared your bottle. You 1 – 0 Kat. Next round coming up…',
    });
  });

  it('match over: the other player won after you topped out', () => {
    const r = result({ winner: 'a', reason: 'toppedOut', by: 'me', wins: { me: 1, a: 2 }, matchOver: true });
    expect(onlineRoundText(r, 'me', [{ id: 'a', name: 'Kat' }], 3)).toEqual({
      title: 'Kat wins the match', sub: 'You topped out. You 1 – 2 Kat',
    });
  });

  it('several opponents, one left the round', () => {
    const r = result({ winner: 'b', reason: 'forfeit', by: 'a', wins: { me: 0, a: 0, b: 1 } });
    expect(onlineRoundText(r, 'me', [{ id: 'a', name: 'Kat' }, { id: 'b', name: 'Zap' }], 2)).toEqual({
      title: 'Zap takes round 2', sub: 'Kat left the round. You 0 · Kat 0 · Zap 1. Next round coming up…',
    });
  });
});
