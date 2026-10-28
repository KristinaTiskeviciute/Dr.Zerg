import { describe, expect, it } from 'vitest';
import { DAS_DELAY_MS } from '../config';
import { KeyboardInput } from './keyboard';

const STEP = 1000 / 60;

function setup() {
  const target = new EventTarget();
  const kb = new KeyboardInput();
  kb.attach(target as unknown as Window);
  kb.enabled = true;
  const key = (type: 'keydown' | 'keyup', code: string) =>
    target.dispatchEvent(Object.assign(new Event(type), { code, repeat: false }));
  /** Poll for `ms` and count how many right moves came out. */
  const movesOver = (ms: number) => {
    let n = 0;
    for (let t = 0; t < ms; t += STEP) if (kb.poll(STEP).right) n++;
    return n;
  };
  return { kb, key, movesOver };
}

describe('KeyboardInput', () => {
  it('moves once on press, then auto-repeats after the DAS delay', () => {
    const { key, movesOver } = setup();
    key('keydown', 'ArrowRight');
    expect(movesOver(DAS_DELAY_MS - 20)).toBe(1);
    expect(movesOver(300)).toBeGreaterThan(2);
  });

  it('a direction held into a new capsule restarts its auto-repeat (no instant move)', () => {
    const { kb, key, movesOver } = setup();
    key('keydown', 'ArrowRight');
    movesOver(500); // fully auto-repeating
    kb.onNewCapsule();
    expect(movesOver(DAS_DELAY_MS - 20)).toBe(0);
    expect(movesOver(300)).toBeGreaterThan(2);
  });

  it('a fresh press right after the spawn moves at once', () => {
    const { kb, key, movesOver } = setup();
    key('keydown', 'ArrowRight');
    movesOver(500);
    kb.onNewCapsule();
    key('keyup', 'ArrowRight');
    key('keydown', 'ArrowRight');
    expect(movesOver(STEP)).toBe(1);
  });

  it('soft drop held into a new capsule is ignored until pressed again', () => {
    const { kb, key } = setup();
    key('keydown', 'ArrowDown');
    expect(kb.poll(STEP).softDrop).toBe(true);
    kb.onNewCapsule();
    expect(kb.poll(STEP).softDrop).toBe(false);
    key('keyup', 'ArrowDown');
    key('keydown', 'ArrowDown');
    expect(kb.poll(STEP).softDrop).toBe(true);
  });

  it('keys pressed after the spawn are not blocked', () => {
    const { kb, key, movesOver } = setup();
    kb.onNewCapsule();
    key('keydown', 'ArrowRight');
    expect(movesOver(STEP)).toBe(1);
  });
});

describe('touch input (via KeyboardInput)', () => {
  it('queued one-column moves come out one per step, in order', () => {
    const kb = new KeyboardInput();
    kb.enabled = true;
    kb.nudge('right'); kb.nudge('right'); kb.nudge('left');
    const moves = [1, 2, 3, 4].map(() => { const s = kb.poll(16); return s.left ? 'L' : s.right ? 'R' : '-'; });
    expect(moves).toEqual(['R', 'R', 'L', '-']);
  });

  it('a touch push holds that way without auto-repeating', () => {
    const kb = new KeyboardInput();
    kb.enabled = true;
    kb.setTouchHold('left');
    let moves = 0;
    for (let i = 0; i < 60; i++) {
      const s = kb.poll(16);
      expect(s.holdLeft).toBe(true);
      if (s.left) moves++;
    }
    expect(moves).toBe(0);
    kb.setTouchHold(null);
    expect(kb.poll(16).holdLeft).toBe(false);
  });
});
