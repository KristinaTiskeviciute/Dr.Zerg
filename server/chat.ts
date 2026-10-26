import { CHAT_HISTORY, type ChatLine } from '../src/net/protocol';

/** Messages (chat lines and emotes) a player can send in a burst, then one more per REFILL_MS. */
export const CHAT_BURST = 5;
export const CHAT_REFILL_MS = 1000;

/** A room's recent chat, and a per-player limit so nobody can flood it. */
export class RoomChat {
  private lines: ChatLine[] = [];
  private budgets = new Map<string, { tokens: number; at: number }>();

  get history(): ChatLine[] {
    return [...this.lines];
  }

  /** Spend one message from this player's budget; false when they're sending too fast. */
  allow(id: string, now: number): boolean {
    const b = this.budgets.get(id) ?? { tokens: CHAT_BURST, at: now };
    b.tokens = Math.min(CHAT_BURST, b.tokens + (now - b.at) / CHAT_REFILL_MS);
    b.at = now;
    this.budgets.set(id, b);
    if (b.tokens < 1) return false;
    b.tokens -= 1;
    return true;
  }

  add(line: ChatLine): void {
    this.lines.push(line);
    if (this.lines.length > CHAT_HISTORY) this.lines.splice(0, this.lines.length - CHAT_HISTORY);
  }

  clear(): void {
    this.lines = [];
    this.budgets.clear();
  }
}
