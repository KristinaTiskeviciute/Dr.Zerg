/**
 * Touch controls (opt-in): drag sideways to move, tap to rotate, drag down and hold to soft-drop.
 * Gesture holds the rules (no DOM, so it's testable); TouchControls feeds it the screen touches.
 */

export type Side = 'left' | 'right';

/** What gestures do to the game (wired to the keyboard input in main.ts). */
export interface GestureSink {
  /** Move one column. */
  nudge(dir: Side): void;
  /** Keep pushing that way (slides into a gap as it lines up), or stop pushing (null). */
  hold(dir: Side | null): void;
  softDrop(on: boolean): void;
  rotate(dir: 'cw' | 'ccw'): void;
}

/** A tap: short and nearly still. */
const TAP_MS = 250;
const TAP_SLOP = 0.6; // cells
/** Finger travel per column moved, and extra for the first one (so a wobbly tap or drop doesn't move). */
const MOVE_STEP = 1.1; // cells
const FIRST_STEP_EXTRA = 0.2; // cells
/** Drag this far down (more down than sideways) to start soft-dropping. */
const DROP_START = 1.5; // cells
/** Move back this far against the last move to stop pushing. */
const BACK_OFF = 0.5; // cells

export class Gesture {
  private startX = 0;
  private startY = 0;
  private startT = 0;
  /** Finger position at the last column moved. */
  private lastX = 0;
  private moved = false;
  private dropping = false;
  private everDropped = false;
  private pushing: Side | null = null;

  /** cellPx: one board cell on screen; middle: x of the screen's middle (left taps rotate ↺, right ↻). */
  constructor(
    private readonly sink: GestureSink,
    private readonly cellPx: () => number,
    private readonly middle: () => number,
  ) {}

  down(x: number, y: number, t: number): void {
    this.startX = this.lastX = x;
    this.startY = y;
    this.startT = t;
    this.moved = this.dropping = this.everDropped = false;
    this.pushing = null;
  }

  move(x: number, y: number): void {
    const c = this.cellPx();
    const step = c * MOVE_STEP;
    // Sideways: one column per step of finger travel (the first takes a bit more); keep pushing
    // that way afterwards. Not while dropping, so a slightly slanted drag down stays put.
    const need = () => step + (this.moved ? 0 : c * FIRST_STEP_EXTRA);
    while (!this.dropping && x - this.lastX >= need()) this.step('right', need());
    while (!this.dropping && this.lastX - x >= need()) this.step('left', -need());
    if (this.pushing === 'right' && this.lastX - x > c * BACK_OFF) this.setPush(null);
    if (this.pushing === 'left' && x - this.lastX > c * BACK_OFF) this.setPush(null);
    // Down: soft drop while the finger stays down there.
    const dy = y - this.startY;
    if (!this.dropping && dy > c * DROP_START && dy > Math.abs(x - this.startX)) {
      this.dropping = this.everDropped = true;
      this.sink.softDrop(true);
    } else if (this.dropping && dy < (c * DROP_START) / 2) {
      this.dropping = false;
      this.sink.softDrop(false);
    }
  }

  up(x: number, y: number, t: number): void {
    if (this.dropping) this.sink.softDrop(false);
    this.dropping = false;
    this.setPush(null);
    const still = Math.hypot(x - this.startX, y - this.startY) < this.cellPx() * TAP_SLOP;
    if (!this.moved && !this.everDropped && still && t - this.startT < TAP_MS) {
      this.sink.rotate(x < this.middle() ? 'ccw' : 'cw');
    }
  }

  private step(dir: Side, by: number): void {
    this.lastX += by;
    this.moved = true;
    this.sink.nudge(dir);
    this.setPush(dir);
  }

  private setPush(dir: Side | null): void {
    if (dir === this.pushing) return;
    this.pushing = dir;
    this.sink.hold(dir);
  }
}

/** Touches on these are normal taps (buttons, menus, chat), never gestures. */
const UI = 'button, input, a, label, .chat-dock, .audio-toggles, .osk, .volume-panel, .touch-pad';

/**
 * Screen touches → Gesture, while `active()` (touch controls on and a round running).
 * One finger at a time; mouse and pen are ignored.
 */
export class TouchControls {
  private readonly gesture: Gesture;
  private pointer: number | null = null;

  constructor(sink: GestureSink, cellPx: () => number, private readonly active: () => boolean) {
    this.gesture = new Gesture(sink, cellPx, () => document.documentElement.clientWidth / 2);
    document.addEventListener('pointerdown', e => {
      if (e.pointerType !== 'touch' || this.pointer !== null || !this.active()) return;
      if (e.target instanceof Element && e.target.closest(UI)) return;
      this.pointer = e.pointerId;
      this.gesture.down(e.clientX, e.clientY, e.timeStamp);
      e.preventDefault();
    }, { passive: false });
    document.addEventListener('pointermove', e => {
      if (e.pointerId === this.pointer) this.gesture.move(e.clientX, e.clientY);
    });
    const end = (e: PointerEvent) => {
      if (e.pointerId !== this.pointer) return;
      this.pointer = null;
      this.gesture.up(e.clientX, e.clientY, e.timeStamp);
    };
    document.addEventListener('pointerup', end);
    document.addEventListener('pointercancel', end);
  }
}
