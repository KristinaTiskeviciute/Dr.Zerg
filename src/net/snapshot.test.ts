import { describe, expect, it } from 'vitest';
import { Game } from '../core/game';
import { Color } from '../core/types';
import { gameView } from '../render/view';
import { isSnapshot } from './protocol';
import { encodeSnapshot, snapshotView } from './snapshot';

const STEP = 1000 / 60;

/** Play a few capsules so the board has germs, joined halves, singles and garbage. */
function busyGame(): Game {
  const g = new Game({ level: 12, speed: 'high', seed: 77 });
  g.receiveGarbage([Color.Red, Color.Blue]);
  for (let i = 0; i < 3000 && g.pieceIndex < 6 && !g.isOver; i++) g.step(STEP, { softDrop: true, left: i % 40 === 0 });
  g.receiveGarbage([Color.Yellow]);
  return g;
}

describe('board snapshots', () => {
  it('round-trip: the other player sees exactly what you see', () => {
    const g = busyGame();
    const mine = gameView(g);
    const theirs = snapshotView(encodeSnapshot(g));
    expect(theirs.cells).toEqual(mine.cells);
    expect(theirs.active).toEqual(mine.active);
    expect(theirs.next).toEqual(mine.next);
    expect(theirs.incoming?.colors).toEqual(mine.incoming?.colors);
  });

  it('passes the server-side shape check', () => {
    expect(isSnapshot(encodeSnapshot(busyGame()))).toBe(true);
    expect(isSnapshot(encodeSnapshot(new Game({ level: 0, speed: 'low', seed: 1 })))).toBe(true);
  });

  it('is small enough to send 10 times a second', () => {
    expect(JSON.stringify(encodeSnapshot(busyGame())).length).toBeLessThan(400);
  });

  it('rejects malformed snapshots', () => {
    const good = encodeSnapshot(busyGame());
    expect(isSnapshot({ ...good, c: good.c.slice(1) })).toBe(false);
    expect(isSnapshot({ ...good, c: 'z'.repeat(128) })).toBe(false);
    expect(isSnapshot({ ...good, a: [0, 9, 0, 0, 0] })).toBe(false);
    expect(isSnapshot({ ...good, k: [500] })).toBe(false);
    expect(isSnapshot({ ...good, q: '3' })).toBe(false);
    expect(isSnapshot(null)).toBe(false);
  });
});
