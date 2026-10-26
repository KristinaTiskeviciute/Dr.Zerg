// Room state for one game room: who's in, who's host, settings, ready flags, starting.
// Pure logic (no Cloudflare APIs) so it can be unit-tested; server/index.ts wires it up.

import { ROUNDS_TO_WIN, Speed } from '../src/config';
import { garbageTargets } from '../src/core/targeting';
import { Color } from '../src/core/types';
import {
  ErrorCode, LobbyPlayer, LobbyState, MAX_PLAYERS, MIN_PLAYERS, Outcome, ROUND_BREAK_MS, RoomSettings, RoundResult,
  START_COUNTDOWN_MS, StartInfo,
} from '../src/net/protocol';

interface MatchState {
  round: number;
  wins: Record<string, number>;
  /** True between a round's result and the next round's start. */
  roundOver: boolean;
  /** Knocked out of the current round. */
  out: Set<string>;
}

/** What a player's report (or leaving) changed: who's now out, and the round result if it's decided. */
export interface Report {
  out: { id: string; reason: Outcome | 'disconnect' } | null;
  round: RoundResult | null;
}

export type Result<T = void> = { ok: true; value: T } | { ok: false; code: ErrorCode; message: string };

const ok = <T>(value: T): Result<T> => ({ ok: true, value });
const fail = (code: ErrorCode, message: string): Result<never> => ({ ok: false, code, message });

export class Lobby {
  private players: LobbyPlayer[] = [];
  private hostId: string | null = null;
  private fastGarbage = false;
  private outbreak = false;
  private phase: LobbyState['phase'] = 'lobby';
  private match: MatchState | null = null;

  constructor(readonly code: string) {}

  get state(): LobbyState {
    return {
      code: this.code,
      hostId: this.hostId,
      players: this.players.map(p => ({ ...p })),
      settings: this.settings,
      phase: this.phase,
    };
  }

  /** A player connects (or reconnects with the same id). */
  join(id: string, name: string): Result {
    const existing = this.find(id);
    if (existing) {
      existing.connected = true;
      existing.name = name;
      return ok(undefined);
    }
    if (this.phase === 'playing') return fail('inProgress', 'A game is already being played in this room.');
    if (this.players.length >= MAX_PLAYERS) return fail('full', 'This room is full.');
    this.players.push({ id, name, ready: false, level: 5, speed: 'med', connected: true, voice: false });
    this.hostId ??= id;
    return ok(undefined);
  }

  /** Their connection dropped. They keep their seat until removed (see remove). */
  disconnect(id: string): void {
    const p = this.find(id);
    if (!p) return;
    p.connected = false;
    p.voice = false; // their voice connections are gone; they rejoin voice when they're back
    if (this.phase === 'lobby') p.ready = false;
  }

  /** Joined or left the voice chat (any time, also mid-match). */
  setVoice(id: string, on: boolean): Result {
    const p = this.find(id);
    if (!p) return fail('notAllowed', 'Join the room first.');
    p.voice = on;
    return ok(undefined);
  }

  isHere(id: string): boolean {
    return this.find(id) !== undefined;
  }

  isConnected(id: string): boolean {
    return this.find(id)?.connected ?? false;
  }

  /**
   * Free their seat for good. If they were host, the next player becomes host. A match
   * carries on without them while at least two players are left.
   */
  remove(id: string): void {
    this.players = this.players.filter(p => p.id !== id);
    if (this.hostId === id) this.hostId = this.players[0]?.id ?? null;
    if (this.match) {
      delete this.match.wins[id];
      this.match.out.delete(id);
      if (this.players.length < MIN_PLAYERS) this.backToLobby();
    }
  }

  nameOf(id: string): string {
    return this.find(id)?.name ?? 'Player';
  }

  get isEmpty(): boolean {
    return this.players.every(p => !p.connected);
  }

  setup(id: string, level: number, speed: Speed): Result {
    const p = this.find(id);
    if (!p || this.phase !== 'lobby') return fail('notAllowed', "Can't change that now.");
    p.level = level;
    p.speed = speed;
    return ok(undefined);
  }

  setReady(id: string, ready: boolean): Result {
    const p = this.find(id);
    if (!p || this.phase !== 'lobby') return fail('notAllowed', "Can't change that now.");
    p.ready = ready;
    return ok(undefined);
  }

  private get settings(): RoomSettings {
    return { fastGarbage: this.fastGarbage, outbreak: this.outbreak };
  }

  /** Room settings: host only, lobby only (locked once a match starts). Unset fields stay as they are. */
  setSettings(id: string, change: Partial<RoomSettings>): Result {
    if (id !== this.hostId) return fail('notAllowed', 'Only the host can change room settings.');
    if (this.phase !== 'lobby') return fail('notAllowed', 'Settings are locked during a match.');
    if (change.fastGarbage !== undefined) this.fastGarbage = change.fastGarbage;
    if (change.outbreak !== undefined) this.outbreak = change.outbreak;
    return ok(undefined);
  }

  /** 2–4 players, all here and ready. */
  get canStart(): boolean {
    return this.phase === 'lobby'
      && this.players.length >= MIN_PLAYERS
      && this.players.every(p => p.ready && p.connected);
  }

  /** Host starts the match: everyone gets the same seed and a countdown. */
  start(id: string, seed: number): Result<StartInfo> {
    if (id !== this.hostId) return fail('notAllowed', 'Only the host can start.');
    if (!this.canStart) return fail('notAllowed', 'Everyone needs to be here and ready.');
    this.phase = 'playing';
    this.match = {
      round: 1, wins: Object.fromEntries(this.players.map(p => [p.id, 0])), roundOver: false, out: new Set(),
    };
    return ok(this.startInfo(seed));
  }

  /** Who a chain's garbage goes to (player ids), from the colors of its first clear. Seats = join order. */
  garbageTargets(from: string, firstColors: Color[]): string[] {
    const m = this.match;
    const seat = this.players.findIndex(p => p.id === from);
    if (!m || m.roundOver || seat < 0 || m.out.has(from)) return [];
    const alive = this.players.map(p => !m.out.has(p.id));
    return garbageTargets(seat, alive, firstColors, this.outbreak).map(i => this.players[i].id);
  }

  get inMatch(): boolean {
    return this.phase === 'playing' && this.match !== null;
  }

  get roundOver(): boolean {
    return this.match?.roundOver ?? false;
  }

  /**
   * A player reports how their round ended. Clearing your bottle wins the round at once;
   * topping out or forfeiting knocks you out, and the round goes to the last one standing.
   * The first deciding report wins (so two near-simultaneous clears can't both count).
   * Returns null if the report is too late or doesn't apply.
   */
  result(id: string, outcome: Outcome): Report | null {
    const m = this.match;
    if (!this.inMatch || !m || m.roundOver || !this.find(id) || m.out.has(id)) return null;
    if (outcome === 'cleared') return { out: null, round: this.finishRound(id, 'cleared', id, false) };
    return this.knockOut(id, outcome, false);
  }

  /** The next round of the match, if the last one is over and everyone left is here. */
  nextRound(seed: number): StartInfo | null {
    const m = this.match;
    if (!this.inMatch || !m || !m.roundOver) return null;
    if (this.players.length < MIN_PLAYERS || !this.players.every(p => p.connected)) return null;
    m.round++;
    m.roundOver = false;
    m.out.clear();
    return this.startInfo(seed);
  }

  /**
   * A player didn't come back in time. With two players the other one wins the match; with
   * more, they're knocked out of this round (and their seat is freed afterwards, see remove).
   */
  abandon(id: string): Report | null {
    const m = this.match;
    if (!this.inMatch || !m) return null;
    if (this.players.length <= 2) {
      const other = this.players.find(p => p.id !== id)?.id ?? null;
      return { out: { id, reason: 'disconnect' }, round: this.finishRound(other, 'disconnect', id, true) };
    }
    if (m.roundOver || m.out.has(id)) return { out: null, round: null };
    return this.knockOut(id, 'disconnect', false);
  }

  private knockOut(id: string, reason: Outcome | 'disconnect', forceEnd: boolean): Report {
    const m = this.match!;
    m.out.add(id);
    const alive = this.players.filter(p => !m.out.has(p.id));
    if (alive.length > 1) return { out: { id, reason }, round: null };
    // One (or nobody) left: the round is decided.
    const winner = alive[0]?.id ?? null;
    const round = this.players.length === 2
      ? this.finishRound(winner, reason, id, forceEnd)
      : this.finishRound(winner, 'lastStanding', winner ?? id, forceEnd);
    return { out: { id, reason }, round };
  }

  /**
   * "Play again" from the results screen: you're ready for another match, and it starts
   * (no host needed) once everyone has said so. Returns the start info when it does.
   */
  playAgain(id: string, seed: number): Result<StartInfo | null> {
    const ready = this.setReady(id, true);
    if (!ready.ok) return ready;
    if (!this.canStart || !this.hostId) return ok(null);
    const started = this.start(this.hostId, seed);
    return ok(started.ok ? started.value : null);
  }

  /** After a match: everyone back to the lobby, same settings, not ready. */
  backToLobby(): void {
    this.phase = 'lobby';
    this.match = null;
    for (const p of this.players) p.ready = false;
  }

  /** Players knocked out of the current round. */
  get outPlayers(): string[] {
    return [...(this.match?.out ?? [])];
  }

  private finishRound(winner: string | null, reason: RoundResult['reason'], by: string, forceEnd: boolean): RoundResult {
    const m = this.match!;
    if (winner) m.wins[winner] = (m.wins[winner] ?? 0) + 1;
    m.roundOver = true;
    const matchOver = forceEnd || Object.values(m.wins).some(w => w >= ROUNDS_TO_WIN);
    const result: RoundResult = { winner, reason, by, wins: { ...m.wins }, matchOver, nextInMs: matchOver ? null : ROUND_BREAK_MS };
    if (matchOver) this.backToLobby();
    return result;
  }

  private startInfo(seed: number): StartInfo {
    return {
      seed,
      startInMs: START_COUNTDOWN_MS,
      players: this.players.map(({ id, name, level, speed }) => ({ id, name, level, speed })),
      settings: this.settings,
      round: this.match!.round,
      wins: { ...this.match!.wins },
    };
  }

  private find(id: string): LobbyPlayer | undefined {
    return this.players.find(p => p.id === id);
  }
}
