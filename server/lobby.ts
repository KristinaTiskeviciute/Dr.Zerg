// Room state for one game room: who's in, who's host, settings, ready flags, starting.
// Pure logic (no Cloudflare APIs) so it can be unit-tested; server/index.ts wires it up.

import { ROUNDS_TO_WIN, Speed } from '../src/config';
import {
  ErrorCode, LobbyPlayer, LobbyState, MAX_PLAYERS, Outcome, ROUND_BREAK_MS, RoundResult, START_COUNTDOWN_MS, StartInfo,
} from '../src/net/protocol';

interface MatchState {
  round: number;
  wins: Record<string, number>;
  /** True between a round's result and the next round's start. */
  roundOver: boolean;
}

export type Result<T = void> = { ok: true; value: T } | { ok: false; code: ErrorCode; message: string };

const ok = <T>(value: T): Result<T> => ({ ok: true, value });
const fail = (code: ErrorCode, message: string): Result<never> => ({ ok: false, code, message });

export class Lobby {
  private players: LobbyPlayer[] = [];
  private hostId: string | null = null;
  private fastGarbage = false;
  private phase: LobbyState['phase'] = 'lobby';
  private match: MatchState | null = null;

  constructor(readonly code: string) {}

  get state(): LobbyState {
    return {
      code: this.code,
      hostId: this.hostId,
      players: this.players.map(p => ({ ...p })),
      settings: { fastGarbage: this.fastGarbage },
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
    this.players.push({ id, name, ready: false, level: 5, speed: 'med', connected: true });
    this.hostId ??= id;
    return ok(undefined);
  }

  /** Their connection dropped. They keep their seat until removed (see remove). */
  disconnect(id: string): void {
    const p = this.find(id);
    if (!p) return;
    p.connected = false;
    if (this.phase === 'lobby') p.ready = false;
  }

  isConnected(id: string): boolean {
    return this.find(id)?.connected ?? false;
  }

  /** Free their seat for good. If they were host, the next player becomes host. */
  remove(id: string): void {
    this.players = this.players.filter(p => p.id !== id);
    if (this.hostId === id) this.hostId = this.players[0]?.id ?? null;
    if (this.players.length < MAX_PLAYERS) this.backToLobby();
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

  /** Room settings: host only, lobby only (locked once a match starts). */
  setSettings(id: string, fastGarbage: boolean): Result {
    if (id !== this.hostId) return fail('notAllowed', 'Only the host can change room settings.');
    if (this.phase !== 'lobby') return fail('notAllowed', 'Settings are locked during a match.');
    this.fastGarbage = fastGarbage;
    return ok(undefined);
  }

  get canStart(): boolean {
    return this.phase === 'lobby'
      && this.players.length === MAX_PLAYERS
      && this.players.every(p => p.ready && p.connected);
  }

  /** Host starts the match: everyone gets the same seed and a countdown. */
  start(id: string, seed: number): Result<StartInfo> {
    if (id !== this.hostId) return fail('notAllowed', 'Only the host can start.');
    if (!this.canStart) return fail('notAllowed', 'Everyone needs to be here and ready.');
    this.phase = 'playing';
    this.match = { round: 1, wins: Object.fromEntries(this.players.map(p => [p.id, 0])), roundOver: false };
    return ok(this.startInfo(seed));
  }

  get inMatch(): boolean {
    return this.phase === 'playing' && this.match !== null;
  }

  get roundOver(): boolean {
    return this.match?.roundOver ?? false;
  }

  /**
   * A player reports how their round ended. The first report decides the round
   * (so two near-simultaneous wins can't both count). Returns null if it's too late.
   */
  result(id: string, outcome: Outcome): RoundResult | null {
    if (!this.inMatch || this.match!.roundOver || !this.find(id)) return null;
    const other = this.players.find(p => p.id !== id)?.id ?? null;
    return this.finishRound(outcome === 'cleared' ? id : other, outcome, id, false);
  }

  /** The next round of the match, if the last one is over and both players are here. */
  nextRound(seed: number): StartInfo | null {
    if (!this.inMatch || !this.match!.roundOver) return null;
    if (!this.players.every(p => p.connected) || this.players.length < MAX_PLAYERS) return null;
    this.match!.round++;
    this.match!.roundOver = false;
    return this.startInfo(seed);
  }

  /** A player didn't come back in time: the other player wins the match. */
  abandon(id: string): RoundResult | null {
    if (!this.inMatch) return null;
    const other = this.players.find(p => p.id !== id)?.id ?? null;
    return this.finishRound(other, 'disconnect', id, true);
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
      settings: { fastGarbage: this.fastGarbage },
      round: this.match!.round,
      wins: { ...this.match!.wins },
    };
  }

  private find(id: string): LobbyPlayer | undefined {
    return this.players.find(p => p.id === id);
  }
}
