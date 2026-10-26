import { Action } from './keyboard';

/**
 * Game controller support (e.g. a PS5 DualSense) via the browser Gamepad API.
 * Uses the "standard" button layout, which the browser maps for us:
 *   Circle (1) rotate clockwise · Cross (0) rotate counter-clockwise
 *   D-pad / left stick: left/right move, down soft drop, D-pad up rotate clockwise
 *   Options (9) pause · Cross or Options also confirms menus between rounds · Create (8) voice mute
 *   In menus: D-pad / stick move between buttons (held: repeats), Circle goes back
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
/** Holding a direction in a menu: first repeat after this long, then every NAV_REPEAT_MS. */
const NAV_DELAY_MS = 400;
const NAV_REPEAT_MS = 110;
const CROSS = 0;
const CIRCLE = 1;
const CREATE = 8;
const OPTIONS = 9;

export type NavDir = 'up' | 'down' | 'left' | 'right';

export interface PadTarget {
  press(action: Action): void;
  release(action: Action): void;
}

export interface PadHandlers {
  /** Options was pressed (pause / resume). */
  onPause(): void;
  /** Cross or Options: confirm the focused menu button (if a menu is up). Return true if used. */
  onConfirm(button: 'cross' | 'options'): boolean;
  /** Circle: back (in menus). */
  onBack(): void;
  /** D-pad or stick pushed (and repeated while held): move around a menu. */
  onNavigate(dir: NavDir): void;
  /** Create (the small button left of the touchpad): mute / unmute voice. */
  onMute(): void;
  /** A controller was connected or disconnected. */
  onChange(connected: boolean): void;
}

export class GamepadInput {
  private actionsDown = new Set<Action>();
  private buttonsDown = new Set<number>();
  private nav: { dir: NavDir | null; next: number } = { dir: null, next: 0 };
  private index: number | null = null;

  constructor(private readonly target: PadTarget, private readonly handlers: PadHandlers) {
    window.addEventListener('gamepadconnected', e => {
      if (this.index === null) this.index = e.gamepad.index;
      const act = (e.gamepad as Gamepad & { vibrationActuator?: { effects?: string[] } }).vibrationActuator;
      // Rumble support varies a lot by browser and connection (e.g. DualSense over Bluetooth).
      console.info(
        `[controller] ${e.gamepad.id} · layout: ${e.gamepad.mapping || 'non-standard'} · rumble: ` +
        (act ? `yes (${act.effects?.join(', ') ?? 'effects not listed'})` : 'not supported by this browser/connection'),
      );
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
      if (!this.handlers.onConfirm('options')) this.handlers.onPause();
    } else if (pressedNow(CROSS)) {
      this.handlers.onConfirm('cross');
    }
    if (pressedNow(CIRCLE)) this.handlers.onBack();
    if (pressedNow(CREATE)) this.handlers.onMute();
    this.buttonsDown = new Set([CROSS, CIRCLE, CREATE, OPTIONS].filter(down));

    // Menu navigation: one step per push of the D-pad or stick, repeating while held.
    const stickX = Math.abs(x) > Math.abs(y);
    const dir: NavDir | null =
      down(12) || (!stickX && y < -STICK_THRESHOLD) ? 'up' :
      down(13) || (!stickX && y > STICK_THRESHOLD) ? 'down' :
      down(14) || (stickX && x < -STICK_THRESHOLD) ? 'left' :
      down(15) || (stickX && x > STICK_THRESHOLD) ? 'right' : null;
    const t = performance.now();
    if (dir !== this.nav.dir) {
      this.nav = { dir, next: t + NAV_DELAY_MS };
      if (dir) this.handlers.onNavigate(dir);
    } else if (dir && t >= this.nav.next) {
      this.nav.next = t + NAV_REPEAT_MS;
      this.handlers.onNavigate(dir);
    }
  }

  /** Rumble, if the controller and browser support it. */
  rumble(ms: number, strong: number, weak: number): void {
    type Actuator = { playEffect?: (type: string, params: object) => Promise<unknown> | undefined };
    const pad = this.pad() as (Gamepad & { vibrationActuator?: Actuator }) | null;
    try {
      const result = pad?.vibrationActuator?.playEffect?.('dual-rumble', {
        startDelay: 0, duration: ms, strongMagnitude: Math.min(1, strong), weakMagnitude: Math.min(1, weak),
      });
      result?.catch?.(err => this.warnOnce(`rumble refused by the browser: ${err}`));
    } catch (err) {
      this.warnOnce(`rumble failed: ${err}`);
    }
  }

  private warned = false;
  private warnOnce(msg: string): void {
    if (this.warned) return;
    this.warned = true;
    console.warn(`[controller] ${msg}`);
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
