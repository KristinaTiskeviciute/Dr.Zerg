import { DAS_DELAY_MS, DAS_REPEAT_MS } from '../config';
import { StepInput } from '../core/game';

export type Action = 'left' | 'right' | 'softDrop' | 'rotateCW' | 'rotateCCW';

/** Action → KeyboardEvent.code values. Rebindable later. */
export type Bindings = Record<Action, string[]>;

export const DEFAULT_BINDINGS: Bindings = {
  left: ['ArrowLeft'],
  right: ['ArrowRight'],
  softDrop: ['ArrowDown', 'Space'],
  rotateCW: ['ArrowUp', 'KeyX'],
  rotateCCW: ['KeyZ'],
};

/**
 * Turns key events into per-step game input, with DAS for sideways movement:
 * one move on press, then auto-repeat after DAS_DELAY_MS at DAS_REPEAT_MS.
 */
export class KeyboardInput {
  private readonly held = new Set<Action>();
  private readonly pressed = new Set<Action>(); // pressed since last poll (catches very short taps)
  private readonly codeToAction = new Map<string, Action>();
  private horizontal: 'left' | 'right' | null = null;
  private dasTimer = 0;
  private repeating = false;
  private freshPress = false;
  /** Keys held over from the previous capsule that are ignored until released and pressed again (soft drop). */
  private readonly blocked = new Set<Action>();
  /** While false, keys pass through untouched (so Space still works on menu buttons). */
  enabled = false;

  constructor(bindings: Bindings = DEFAULT_BINDINGS) {
    for (const [action, codes] of Object.entries(bindings) as [Action, string[]][]) {
      for (const code of codes) this.codeToAction.set(code, action);
    }
  }

  attach(target: Window = window): () => void {
    const down = (e: KeyboardEvent) => this.onKeyDown(e);
    const up = (e: KeyboardEvent) => this.onKeyUp(e);
    const blur = () => this.reset();
    target.addEventListener('keydown', down);
    target.addEventListener('keyup', up);
    target.addEventListener('blur', blur);
    return () => {
      target.removeEventListener('keydown', down);
      target.removeEventListener('keyup', up);
      target.removeEventListener('blur', blur);
    };
  }

  reset(): void {
    this.held.clear();
    this.pressed.clear();
    this.horizontal = null;
    this.repeating = false;
    this.freshPress = false;
    this.blocked.clear();
  }

  /**
   * Call when a new capsule spawns. A held soft drop is ignored until pressed again;
   * a held left/right restarts its auto-repeat (no instant move, then DAS as if newly held).
   */
  onNewCapsule(): void {
    if (this.held.has('softDrop')) this.blocked.add('softDrop');
    if (this.horizontal && this.held.has(this.horizontal)) {
      this.freshPress = false;
      this.repeating = false;
      this.dasTimer = 0;
    }
  }

  /** Call once per simulation step. */
  poll(dt: number): StepInput {
    const out: StepInput = {
      rotateCW: this.pressed.has('rotateCW'),
      rotateCCW: this.pressed.has('rotateCCW'),
      softDrop: !this.blocked.has('softDrop') && (this.held.has('softDrop') || this.pressed.has('softDrop')),
    };

    if (this.horizontal) {
      if (this.freshPress) {
        out[this.horizontal] = true;
        this.freshPress = false;
        this.dasTimer = 0;
        this.repeating = false;
      } else if (this.held.has(this.horizontal)) {
        this.dasTimer += dt;
        if (!this.repeating && this.dasTimer >= DAS_DELAY_MS) {
          out[this.horizontal] = true;
          this.repeating = true;
          this.dasTimer = 0;
        } else if (this.repeating && this.dasTimer >= DAS_REPEAT_MS) {
          out[this.horizontal] = true;
          this.dasTimer -= DAS_REPEAT_MS;
        }
      }
      if (!this.held.has(this.horizontal)) {
        // Released: fall back to the other direction if it's still held.
        const other = this.horizontal === 'left' ? 'right' : 'left';
        this.horizontal = this.held.has(other) ? other : null;
        this.dasTimer = 0;
        this.repeating = false;
      }
    }

    this.pressed.clear();
    return out;
  }

  /** An action's button went down (keyboard or controller). */
  press(action: Action): void {
    if (!this.enabled) return;
    this.held.add(action);
    this.pressed.add(action);
    this.blocked.delete(action);
    if (action === 'left' || action === 'right') {
      this.horizontal = action;
      this.freshPress = true;
    }
  }

  /** An action's button came up. */
  release(action: Action): void {
    this.held.delete(action);
    this.blocked.delete(action);
  }

  private onKeyDown(e: KeyboardEvent): void {
    const action = this.codeToAction.get(e.code);
    if (!action || !this.enabled) return;
    e.preventDefault();
    if (!e.repeat) this.press(action);
  }

  private onKeyUp(e: KeyboardEvent): void {
    const action = this.codeToAction.get(e.code);
    if (!action || !this.enabled) return;
    e.preventDefault(); // also stops Space from "clicking" a focused button on release
    this.release(action);
  }
}
