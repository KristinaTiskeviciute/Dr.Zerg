import { GameEvent } from '../core/game';
import { GamepadInput } from './gamepad';

const KEY = 'drzerg.rumble';

/** Controller rumble for game events, with an on/off switch remembered in the browser. */
export class Rumble {
  on = true;

  constructor(private readonly pad: GamepadInput) {
    try {
      this.on = localStorage.getItem(KEY) !== 'off';
    } catch { /* storage unavailable */ }
  }

  toggle(): void {
    this.on = !this.on;
    try {
      localStorage.setItem(KEY, this.on ? 'on' : 'off');
    } catch { /* ignore */ }
  }

  /** Your own board's events. */
  forEvent(e: GameEvent): void {
    switch (e.type) {
      case 'lock': return this.play(35, 0, 0.25);
      case 'clear': return this.play(90 + 30 * e.chain, 0.25 + 0.15 * e.chain, 0.5); // stronger each chain step
      case 'garbageLanded': return this.play(160, 0.8, 0.4);
    }
  }

  /** Garbage was just sent your way. */
  warning(): void {
    this.play(70, 0, 0.6);
  }

  roundEnd(won: boolean): void {
    if (won) this.play(350, 0.4, 0.6);
    else this.play(600, 1, 0.5);
  }

  private play(ms: number, strong: number, weak: number): void {
    if (this.on) this.pad.rumble(ms, strong, weak);
  }
}
