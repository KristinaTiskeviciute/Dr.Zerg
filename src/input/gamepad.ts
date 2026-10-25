import { Action } from './keyboard';

/**
 * Game controller support (e.g. a PS5 DualSense) via the browser Gamepad API.
 * Uses the "standard" button layout, which the browser maps for us:
 *   Circle (1) rotate clockwise · Cross (0) rotate counter-clockwise
 *   D-pad / left stick: left/right move, down soft drop, D-pad up rotate clockwise
 *   Options (9) pause · Cross or Options also confirms menus between rounds
 */
const BUTTON_ACTIONS: [button: number, action: Action][] = [
  [1, 'rotateCW'], // Circle
  [0, 'rotateCCW'], // Cross
  [12, 'rotateCW'], // D-pad up
  [13, 'softDrop'], // D-pad down
  [14, 'left'], // D-pad left
  [15, 'right'], // D-pad right
];
const STICK_THRESHOLD = 0.5;
const CROSS = 0;
const OPTIONS = 9;

export interface PadTarget {
  press(action: Action): void;
  release(action: Action): void;
}

export interface PadHandlers {
  /** Options was pressed (pause / resume). */
  onPause(): void;
  /** Cross or Options while no game is running: confirm the focused menu button. Return true if used. */
  onConfirm(): boolean;
  /** A controller was connected or disconnected. */
  onChange(connected: boolean): void;
}

export class GamepadInput {
  private actionsDown = new Set<Action>();
  private buttonsDown = new Set<number>();
  private index: number | null = null;

  constructor(private readonly target: PadTarget, private readonly handlers: PadHandlers) {
    window.addEventListener('gamepadconnected', e => {
      if (this.index === null) this.index = e.gamepad.index;
      this.handlers.onChange(true);
    });
    window.addEventListener('gamepaddisconnected', e => {
      if (e.gamepad.index !== this.index) return;
      this.index = null;
      for (const a of this.actionsDown) this.target.release(a);
      this.actionsDown.clear();
      this.buttonsDown.clear();
      this.handlers.onChange(false);
    });
  }

  get connected(): boolean {
    return this.pad() !== null;
  }

  /** Call every frame: browsers only report controller state when asked. */
  poll(): void {
    const pad = this.pad();
    if (!pad) return;
    const down = (i: number) => pad.buttons[i]?.pressed ?? false;
    const [x = 0, y = 0] = pad.axes;

    // Game actions: send press/release on changes so auto-repeat works like the keyboard.
    const now = new Set<Action>();
    for (const [button, action] of BUTTON_ACTIONS) if (down(button)) now.add(action);
    if (x < -STICK_THRESHOLD) now.add('left');
    if (x > STICK_THRESHOLD) now.add('right');
    if (y > STICK_THRESHOLD) now.add('softDrop');
    for (const a of now) if (!this.actionsDown.has(a)) this.target.press(a);
    for (const a of this.actionsDown) if (!now.has(a)) this.target.release(a);
    this.actionsDown = now;

    // Pause and menu confirm, on the press only.
    // Options confirms a menu if one is waiting, otherwise pauses; Cross only confirms.
    const pressedNow = (i: number) => down(i) && !this.buttonsDown.has(i);
    if (pressedNow(OPTIONS)) {
      if (!this.handlers.onConfirm()) this.handlers.onPause();
    } else if (pressedNow(CROSS)) {
      this.handlers.onConfirm();
    }
    this.buttonsDown = new Set([CROSS, OPTIONS].filter(down));
  }

  /** Rumble, if the controller and browser support it. */
  rumble(ms: number, strong: number, weak: number): void {
    const pad = this.pad() as (Gamepad & { vibrationActuator?: { playEffect?: Function } }) | null;
    try {
      void pad?.vibrationActuator?.playEffect?.('dual-rumble', {
        duration: ms, strongMagnitude: Math.min(1, strong), weakMagnitude: Math.min(1, weak),
      });
    } catch { /* not supported */ }
  }

  private pad(): Gamepad | null {
    const pads = navigator.getGamepads?.() ?? [];
    if (this.index !== null && pads[this.index]) return pads[this.index];
    // Fall back to any connected controller (some browsers skip the connect event on reload).
    const any = [...pads].find((p): p is Gamepad => !!p && p.connected);
    if (any) this.index = any.index;
    return any ?? null;
  }
}
