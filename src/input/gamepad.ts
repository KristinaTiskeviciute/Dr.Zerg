import { Action } from './keyboard';

/**
 * Game controller support (e.g. a PS5 DualSense) via the browser Gamepad API.
 * Uses the "standard" button layout, which the browser maps for us:
 *   Circle (1) rotate clockwise · Cross (0) rotate counter-clockwise
 *   D-pad / left stick: left/right move, down soft drop, D-pad up rotate clockwise
 *   Options (9) pause · Cross or Options also confirms menus between rounds · Create (8) voice mute
 *   In menus: D-pad / stick move between buttons (held: repeats), Circle goes back
 * Several controllers can be connected at once (local matches).
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
  onPause(pad: number): void;
  /** Cross or Options: confirm the focused menu button (if a menu is up). Return true if used. */
  onConfirm(button: 'cross' | 'options', pad: number): boolean;
  /** Circle: back (in menus). */
  onBack(pad: number): void;
  /** D-pad or stick pushed (and repeated while held): move around a menu. */
  onNavigate(dir: NavDir, pad: number): void;
  /** Create (the small button left of the touchpad): mute / unmute voice. */
  onMute(pad: number): void;
  /** A controller was connected or disconnected. */
  onChange(connected: boolean): void;
}

/** What one controller is doing (each controller is tracked on its own). */
interface PadState {
  actionsDown: Set<Action>;
  buttonsDown: Set<number>;
  nav: { dir: NavDir | null; next: number };
  /** Where its game buttons went last time (to release them there if that changes). */
  target: PadTarget | null;
}

/**
 * All connected controllers. By default every controller drives the same input (the one
 * player); in a local match, `route` sends each controller to its own player. Menu buttons
 * (pause, confirm, back, navigate) work from any controller and say which one it was.
 */
export class GamepadInput {
  private states = new Map<number, PadState>();
  /** The controller used most recently (rumble goes there unless a controller is named). */
  private lastUsed: number | null = null;
  /** Where a controller's game buttons go (null: nowhere, e.g. a controller nobody joined with). */
  route: (pad: number) => PadTarget | null = () => this.target;

  constructor(private readonly target: PadTarget, private readonly handlers: PadHandlers) {
    window.addEventListener('gamepadconnected', e => {
      const act = (e.gamepad as Gamepad & { vibrationActuator?: { effects?: string[] } }).vibrationActuator;
      // Rumble support varies a lot by browser and connection (e.g. DualSense over Bluetooth).
      console.info(
        `[controller] ${e.gamepad.id} · layout: ${e.gamepad.mapping || 'non-standard'} · rumble: ` +
        (act ? `yes (${act.effects?.join(', ') ?? 'effects not listed'})` : 'not supported by this browser/connection'),
      );
      this.handlers.onChange(true);
    });
    window.addEventListener('gamepaddisconnected', e => {
      this.forget(e.gamepad.index);
      this.handlers.onChange(this.connected);
    });
  }

  get connected(): boolean {
    return this.pads().length > 0;
  }

  /** Call every frame: browsers only report controller state when asked. */
  poll(): void {
    const pads = this.pads();
    for (const index of [...this.states.keys()]) if (!pads.some(p => p.index === index)) this.forget(index);
    for (const pad of pads) this.pollPad(pad);
  }

  private pollPad(pad: Gamepad): void {
    let st = this.states.get(pad.index);
    if (!st) {
      st = { actionsDown: new Set(), buttonsDown: new Set(), nav: { dir: null, next: 0 }, target: null };
      this.states.set(pad.index, st);
    }
    const i = pad.index;
    const down = (b: number) => pad.buttons[b]?.pressed ?? false;
    const [x = 0, y = 0] = pad.axes;

    // Game actions: send press/release on changes so auto-repeat works like the keyboard.
    const target = this.route(i);
    if (target !== st.target) { // routed somewhere else now: let go of everything at the old place
      for (const a of st.actionsDown) st.target?.release(a);
      st.actionsDown.clear();
      st.target = target;
    }
    const now = new Set<Action>();
    for (const [button, action] of BUTTON_ACTIONS) if (down(button)) now.add(action);
    if (x < -STICK_THRESHOLD) now.add('left');
    if (x > STICK_THRESHOLD) now.add('right');
    if (y > STICK_THRESHOLD) now.add('softDrop');
    for (const a of now) if (!st.actionsDown.has(a)) target?.press(a);
    for (const a of st.actionsDown) if (!now.has(a)) target?.release(a);
    st.actionsDown = now;
    if (now.size > 0 || pad.buttons.some(b => b.pressed)) this.lastUsed = i;

    // Pause and menu confirm, on the press only.
    // Options confirms a menu if one is waiting, otherwise pauses; Cross only confirms.
    const pressedNow = (b: number) => down(b) && !st.buttonsDown.has(b);
    if (pressedNow(OPTIONS)) {
      if (!this.handlers.onConfirm('options', i)) this.handlers.onPause(i);
    } else if (pressedNow(CROSS)) {
      this.handlers.onConfirm('cross', i);
    }
    if (pressedNow(CIRCLE)) this.handlers.onBack(i);
    if (pressedNow(CREATE)) this.handlers.onMute(i);
    st.buttonsDown = new Set([CROSS, CIRCLE, CREATE, OPTIONS].filter(down));

    // Menu navigation: one step per push of the D-pad or stick, repeating while held.
    const stickX = Math.abs(x) > Math.abs(y);
    const dir: NavDir | null =
      down(12) || (!stickX && y < -STICK_THRESHOLD) ? 'up' :
      down(13) || (!stickX && y > STICK_THRESHOLD) ? 'down' :
      down(14) || (stickX && x < -STICK_THRESHOLD) ? 'left' :
      down(15) || (stickX && x > STICK_THRESHOLD) ? 'right' : null;
    const t = performance.now();
    if (dir !== st.nav.dir) {
      st.nav = { dir, next: t + NAV_DELAY_MS };
      if (dir) this.handlers.onNavigate(dir, i);
    } else if (dir && t >= st.nav.next) {
      st.nav.next = t + NAV_REPEAT_MS;
      this.handlers.onNavigate(dir, i);
    }
  }

  /** A controller went away: let go of its buttons. */
  private forget(index: number): void {
    const st = this.states.get(index);
    if (st) for (const a of st.actionsDown) st.target?.release(a);
    this.states.delete(index);
    if (this.lastUsed === index) this.lastUsed = null;
  }

  /** Rumble, if the controller and browser support it: that controller, or the one used last. */
  rumble(ms: number, strong: number, weak: number, index?: number): void {
    type Actuator = { playEffect?: (type: string, params: object) => Promise<unknown> | undefined };
    const pads = this.pads();
    const want = index ?? this.lastUsed;
    const pad = (pads.find(p => p.index === want) ?? (index === undefined ? pads[0] : undefined)) as
      (Gamepad & { vibrationActuator?: Actuator }) | undefined;
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

  /** Connected controllers (asked every time: some browsers skip the connect event on reload). */
  private pads(): Gamepad[] {
    return [...(navigator.getGamepads?.() ?? [])].filter((p): p is Gamepad => !!p && p.connected);
  }
}
