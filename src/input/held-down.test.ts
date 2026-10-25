import { describe, expect, it } from 'vitest';
import { Game } from '../core/game';
import { Color } from '../core/types';
import { KeyboardInput } from './keyboard';

const STEP = 1000 / 60;
const { Red: R, Yellow: Y, Blue: B } = Color;

/**
 * How long the loose half takes to fall after a clear, with ↓ held the whole time:
 * pressed after the capsule appeared (`pressAt` 3) or held over from before it (`pressAt` 0).
 */
function settleMs(opts: { fastGarbage: boolean; pressAt: number | null }): number {
  const g = new Game({
    level: 0, speed: 'med', seed: 1, fastGarbage: opts.fastGarbage,
    setupBoard: b => {
      b.set(15, 7, { kind: 'germ', color: B });
      b.set(15, 3, { kind: 'germ', color: R });
      b.set(14, 3, { kind: 'pill', color: R, link: 'none' });
      b.set(13, 3, { kind: 'pill', color: R, link: 'none' });
    },
  });
  g.active = { row: 0, col: 3, orientation: 1, colors: [Y, R] }; // red bottom makes 4; yellow falls 4 rows
  const target = new EventTarget();
  const kb = new KeyboardInput();
  kb.attach(target as unknown as Window);
  kb.enabled = true;
  let settling = 0;
  for (let i = 0; i < 3000; i++) {
    if (i === opts.pressAt) target.dispatchEvent(Object.assign(new Event('keydown'), { code: 'ArrowDown', repeat: false }));
    const input = kb.poll(STEP);
    if (g.phase === 'settling') settling += STEP;
    g.step(STEP, input);
    for (const e of g.drainEvents()) if (e.type === 'spawn') kb.onNewCapsule();
    if (g.pieceIndex === 1 && g.phase === 'falling') break;
  }
  return settling;
}

describe('holding ↓ through a clear (Fast garbage)', () => {
  const normal = settleMs({ fastGarbage: true, pressAt: null });

  it('speeds up the leftover blocks when ↓ is held through the lock', () => {
    expect(settleMs({ fastGarbage: true, pressAt: 3 })).toBeLessThan(normal / 2);
  });

  it('also when ↓ was held over from the previous capsule (no need to press again)', () => {
    expect(settleMs({ fastGarbage: true, pressAt: 0 })).toBeLessThan(normal / 2);
  });

  it('does nothing without Fast garbage', () => {
    expect(settleMs({ fastGarbage: false, pressAt: 3 })).toBeCloseTo(normal, -2);
  });
});
