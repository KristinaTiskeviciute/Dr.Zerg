import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { GamepadInput, isXbox, padName } from './gamepad';
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

describe('controller names', () => {
  it('turns browser ids into readable names', () => {
    expect(padName('DualSense Wireless Controller (STANDARD GAMEPAD Vendor: 054c Product: 0ce6)')).toBe('DualSense Wireless Controller');
    expect(padName('054c-0ce6-DualSense Wireless Controller')).toBe('DualSense Wireless Controller'); // Firefox
    expect(padName('Xbox 360 Controller (XInput STANDARD GAMEPAD)')).toBe('Xbox 360 Controller');
    expect(padName('')).toBe('Controller');
  });

  it('spots Xbox controllers', () => {
    expect(isXbox('Xbox Wireless Controller (STANDARD GAMEPAD Vendor: 045e Product: 0b13)')).toBe(true);
    expect(isXbox('045e-0b13-Xbox Wireless Controller')).toBe(true);
    expect(isXbox('DualSense Wireless Controller (STANDARD GAMEPAD Vendor: 054c Product: 0ce6)')).toBe(false);
  });
});

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
      { onPause: () => log.push('pause'), onConfirm: () => { log.push('confirm'); return confirmResult; }, onBack: () => log.push('back'), onMute: () => log.push('mute'), onNavigate: d => log.push(`nav-${d}`), onChange: () => {} },
    );
  });
  afterEach(() => vi.unstubAllGlobals());

  it('maps Circle/Cross to rotations and the D-pad to moves, as press then release', () => {
    fake.set(1, true); input.poll(); // Circle
    fake.set(1, false); input.poll();
    fake.set(14, true); input.poll(); // D-pad left
    input.poll(); // still held: no repeat events from here (auto-repeat is the keyboard input's job)
    fake.set(14, false); input.poll();
    // (Menu events like back/nav are tested separately.)
    expect(log.filter(l => l.startsWith('+') || l.startsWith('-'))).toEqual(['+rotateCW', '-rotateCW', '+left', '-left']);
  });

  it('Cross rotates counter-clockwise (and offers to confirm a menu)', () => {
    fake.set(0, true); input.poll();
    expect(log).toContain('+rotateCCW');
    expect(log).toContain('confirm');
  });

  it('the left stick moves and soft-drops', () => {
    fake.pad.axes[0] = 0.9; input.poll();
    fake.pad.axes[0] = 0; fake.pad.axes[1] = 0.8; input.poll();
    expect(log.filter(l => !l.startsWith('nav'))).toEqual(['+right', '+softDrop', '-right']);
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

  it('steps through menus once per push of the D-pad or stick', () => {
    fake.set(13, true); input.poll(); input.poll();
    fake.set(13, false); input.poll();
    fake.pad.axes[1] = -0.9; input.poll(); input.poll();
    fake.pad.axes[1] = 0; fake.pad.axes[0] = 0.9; input.poll();
    fake.pad.axes[0] = 0; input.poll();
    expect(log.filter(l => l.startsWith('nav'))).toEqual(['nav-down', 'nav-up', 'nav-right']);
  });

  it('repeats a held direction after a delay', () => {
    let t = 0;
    vi.stubGlobal('performance', { now: () => t });
    fake.set(15, true);
    for (t = 0; t <= 700; t += 50) input.poll();
    // First step at once, then repeats from 400 ms every 110 ms: 400, 510, 620.
    expect(log.filter(l => l === 'nav-right')).toHaveLength(4);
  });

  it('Circle is back', () => {
    fake.set(1, true); input.poll(); input.poll();
    expect(log.filter(l => l === 'back')).toEqual(['back']);
  });

  it('Create toggles voice mute once per press', () => {
    fake.set(8, true); input.poll(); input.poll();
    fake.set(8, false); input.poll();
    fake.set(8, true); input.poll();
    expect(log).toEqual(['mute', 'mute']);
  });

  it('rumbles through the controller', () => {
    input.rumble(100, 0.5, 2);
    expect(fake.effects).toEqual([{ startDelay: 0, duration: 100, strongMagnitude: 0.5, weakMagnitude: 1 }]);
  });

  it('routes each controller to its own player, and says which one pressed a menu button', () => {
    const second = fakePad();
    second.pad.index = 1;
    vi.stubGlobal('navigator', { getGamepads: () => [fake.pad, second.pad] });
    const p1: string[] = [];
    const p2: string[] = [];
    input.route = i => (i === 0 ? { press: a => p1.push(a), release: () => {} } : { press: a => p2.push(a), release: () => {} });
    fake.set(14, true); second.set(15, true); input.poll();
    expect(p1).toEqual(['left']);
    expect(p2).toEqual(['right']);
    const who: number[] = [];
    input = new GamepadInput({ press: () => {}, release: () => {} }, {
      onPause: () => {}, onConfirm: (_b, pad) => { who.push(pad); return true; }, onBack: () => {}, onMute: () => {}, onNavigate: () => {}, onChange: () => {},
    });
    second.set(0, true); input.poll();
    expect(who).toEqual([1]);
  });

  it('a controller nobody joined with drives nothing', () => {
    input.route = () => null;
    fake.set(14, true); input.poll();
    expect(log.filter(l => l.startsWith('+'))).toEqual([]);
  });

  it('does nothing without a controller', () => {
    vi.stubGlobal('navigator', { getGamepads: () => [null] });
    input.poll();
    input.rumble(100, 1, 1);
    expect(input.connected).toBe(false);
    expect(log).toEqual([]);
  });
});
