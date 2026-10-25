import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { GamepadInput } from './gamepad';
import { Action } from './keyboard';

/** A fake standard-layout controller whose buttons/stick the test can set. */
function fakePad() {
  const buttons = Array.from({ length: 17 }, () => ({ pressed: false, value: 0 }));
  const effects: unknown[] = [];
  const pad = {
    index: 0, connected: true, buttons, axes: [0, 0, 0, 0],
    vibrationActuator: { playEffect: (_type: string, params: unknown) => { effects.push(params); return Promise.resolve(); } },
  };
  return { pad, effects, set: (i: number, on: boolean) => { buttons[i].pressed = on; } };
}

describe('GamepadInput', () => {
  let fake: ReturnType<typeof fakePad>;
  let log: string[];
  let confirmResult: boolean;
  let input: GamepadInput;

  beforeEach(() => {
    fake = fakePad();
    log = [];
    confirmResult = false;
    vi.stubGlobal('window', new EventTarget());
    vi.stubGlobal('navigator', { getGamepads: () => [fake.pad] });
    input = new GamepadInput(
      { press: (a: Action) => log.push(`+${a}`), release: (a: Action) => log.push(`-${a}`) },
      { onPause: () => log.push('pause'), onConfirm: () => { log.push('confirm'); return confirmResult; }, onChange: () => {} },
    );
  });
  afterEach(() => vi.unstubAllGlobals());

  it('maps Circle/Cross to rotations and the D-pad to moves, as press then release', () => {
    fake.set(1, true); input.poll(); // Circle
    fake.set(1, false); input.poll();
    fake.set(14, true); input.poll(); // D-pad left
    input.poll(); // still held: no repeat events from here (auto-repeat is the keyboard input's job)
    fake.set(14, false); input.poll();
    expect(log.filter(l => !l.startsWith('confirm'))).toEqual(['+rotateCW', '-rotateCW', '+left', '-left']);
  });

  it('Cross rotates counter-clockwise (and offers to confirm a menu)', () => {
    fake.set(0, true); input.poll();
    expect(log).toContain('+rotateCCW');
    expect(log).toContain('confirm');
  });

  it('the left stick moves and soft-drops', () => {
    fake.pad.axes[0] = 0.9; input.poll();
    fake.pad.axes[0] = 0; fake.pad.axes[1] = 0.8; input.poll();
    expect(log).toEqual(['+right', '+softDrop', '-right']);
  });

  it('Options pauses during play, but confirms the focused menu button when there is one', () => {
    fake.set(9, true); input.poll();
    expect(log).toEqual(['confirm', 'pause']);
    fake.set(9, false); input.poll();
    log = [];
    confirmResult = true;
    fake.set(9, true); input.poll();
    expect(log).toEqual(['confirm']);
  });

  it('rumbles through the controller', () => {
    input.rumble(100, 0.5, 2);
    expect(fake.effects).toEqual([{ startDelay: 0, duration: 100, strongMagnitude: 0.5, weakMagnitude: 1 }]);
  });

  it('does nothing without a controller', () => {
    vi.stubGlobal('navigator', { getGamepads: () => [null] });
    input.poll();
    input.rumble(100, 1, 1);
    expect(input.connected).toBe(false);
    expect(log).toEqual([]);
  });
});
