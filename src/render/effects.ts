import { LOCK_FLASH_MS, SHAKE_MS, SHAKE_PX } from '../config';
import { GameEvent } from '../core/game';
import { Pos } from '../core/types';

/**
 * Short-lived visual feedback for one board, driven by game events:
 * a white flash on a capsule as it locks, and a little shake on chains and garbage landing.
 * Purely cosmetic; lives outside the game core.
 */
export class BoardEffects {
  private flashes: { pos: Pos; ms: number }[] = [];
  private shakeMs = 0;
  private incomingMs = 0;

  /** Garbage was just sent to this board: make the incoming preview blink for a moment. */
  markIncoming(): void {
    this.incomingMs = INCOMING_BLINK_MS;
  }

  get incomingFresh(): boolean {
    return this.incomingMs > 0;
  }

  onEvents(events: GameEvent[]): void {
    for (const e of events) {
      if (e.type === 'lock') for (const pos of e.cells) this.flashes.push({ pos, ms: LOCK_FLASH_MS });
      if ((e.type === 'clear' && e.chain >= 2) || e.type === 'garbageLanded') this.shakeMs = SHAKE_MS;
    }
  }

  update(dt: number): void {
    for (const f of this.flashes) f.ms -= dt;
    this.flashes = this.flashes.filter(f => f.ms > 0);
    this.shakeMs = Math.max(0, this.shakeMs - dt);
    this.incomingMs = Math.max(0, this.incomingMs - dt);
  }

  get flashList(): { pos: Pos; alpha: number }[] {
    return this.flashes.map(f => ({ pos: f.pos, alpha: f.ms / LOCK_FLASH_MS }));
  }

  /** Offset in sprite pixels to shake the board by right now. */
  shake(now: number): { x: number; y: number } {
    if (this.shakeMs <= 0) return { x: 0, y: 0 };
    const k = (this.shakeMs / SHAKE_MS) * SHAKE_PX;
    return { x: Math.round(Math.sin(now * 0.09) * k), y: Math.round(Math.cos(now * 0.13) * k * 0.6) };
  }

  reset(): void {
    this.flashes = [];
    this.shakeMs = 0;
    this.incomingMs = 0;
  }
}

const INCOMING_BLINK_MS = 900;
