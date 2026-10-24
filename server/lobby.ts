// Room state for one game room: who's in, who's host, settings, ready flags, starting.
// Pure logic (no Cloudflare APIs) so it can be unit-tested; server/index.ts wires it up.

import { Speed } from '../src/config';
import {
  ErrorCode, LobbyPlayer, LobbyState, MAX_PLAYERS, START_COUNTDOWN_MS, StartInfo,
} from '../src/net/protocol';

export type Result<T = void> = { ok: true; value: T } | { ok: false; code: ErrorCode; message: string };

const ok = <T>(value: T): Result<T> => ({ ok: true, value });
const fail = (code: ErrorCode, message: string): Result<never> => ({ ok: false, code, message });

export class Lobby {
  private players: LobbyPlayer[] = [];
  private hostId: string | null = null;
  private fastGarbage = false;
  private phase: LobbyState['phase'] = 'lobby';

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
    p.ready = false;
  }

  isConnected(id: string): boolean {
    return this.find(id)?.connected ?? false;
  }

  /** Free their seat for good. If they were host, the next player becomes host. */
  remove(id: string): void {
    this.players = this.players.filter(p => p.id !== id);
    if (this.hostId === id) this.hostId = this.players[0]?.id ?? null;
    if (this.players.length === 0) this.phase = 'lobby';
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
    return ok({
      seed,
      startInMs: START_COUNTDOWN_MS,
      players: this.players.map(({ id, name, level, speed }) => ({ id, name, level, speed })),
      settings: { fastGarbage: this.fastGarbage },
    });
  }

  /** After a match: everyone back to the lobby, same settings, not ready. */
  backToLobby(): void {
    this.phase = 'lobby';
    for (const p of this.players) p.ready = false;
  }

  private find(id: string): LobbyPlayer | undefined {
    return this.players.find(p => p.id === id);
  }
}
