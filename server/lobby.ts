// Room state for one game room: who's in, who's host, settings, ready flags, starting.
// Pure logic (no Cloudflare APIs) so it can be unit-tested; server/index.ts wires it up.

import { CpuSkillName, ROUNDS_TO_WIN, Speed } from '../src/config';
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

/** CPU players are named after the germs. */
export const CPU_NAMES = ['Spike', 'Buzz', 'Peep'];

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
      for (const g of this.guests(id)) g.connected = true;
      return ok(undefined);
    }
    if (this.phase === 'playing') return fail('inProgress', 'A game is already being played in this room.');
    if (this.players.length >= MAX_PLAYERS) return fail('full', 'This room is full.');
    this.players.push({ id, name, ready: false, level: 5, speed: 'med', connected: true, voice: false, cpu: null, runBy: null, guestOf: null });
    this.hostId ??= id;
    return ok(undefined);
  }

  /** Their connection dropped. They keep their seat until removed (see remove); so do their couch guests. */
  disconnect(id: string): void {
    const p = this.find(id);
    if (!p) return;
    p.connected = false;
    for (const g of this.guests(id)) g.connected = false;
    p.voice = false; // their voice connections are gone; they rejoin voice when they're back
    if (this.phase === 'lobby') p.ready = false;
  }

  /** Host adds a CPU player (lobby only, while there's a free seat). */
  addCpu(id: string, cpuId: string): Result {
    if (id !== this.hostId) return fail('notAllowed', 'Only the host can add CPU players.');
    if (this.phase !== 'lobby') return fail('notAllowed', "Can't change that now.");
    if (this.players.length >= MAX_PLAYERS) return fail('full', 'This room is full.');
    const used = new Set(this.players.map(p => p.name));
    const name = CPU_NAMES.find(n => !used.has(n)) ?? 'CPU';
    this.players.push({ id: cpuId, name, ready: true, level: 5, speed: 'med', connected: true, voice: false, cpu: 'normal', runBy: null, guestOf: null });
    return ok(undefined);
  }

  /** Host changes a CPU's level, speed or skill (unset fields stay as they are). */
  setCpu(id: string, cpuId: string, change: { level?: number; speed?: Speed; skill?: CpuSkillName }): Result {
    const p = this.find(cpuId);
    if (id !== this.hostId || !p?.cpu || this.phase !== 'lobby') return fail('notAllowed', "Can't change that now.");
    if (change.level !== undefined) p.level = change.level;
    if (change.speed !== undefined) p.speed = change.speed;
    if (change.skill !== undefined) p.cpu = change.skill;
    return ok(undefined);
  }

  removeCpu(id: string, cpuId: string): Result {
    const p = this.find(cpuId);
    if (id !== this.hostId || !p?.cpu || this.phase !== 'lobby') return fail('notAllowed', "Can't change that now.");
    this.players = this.players.filter(x => x.id !== cpuId);
    return ok(undefined);
  }

  /**
   * A person adds a couch guest: someone else playing on their browser with their own controller
   * (lobby only, while there's a free seat). Their browser picks the guest's id.
   */
  addGuest(id: string, guestId: string, name: string): Result {
    const host = this.find(id);
    if (!host || host.cpu || host.guestOf) return fail('notAllowed', 'Join the room first.');
    if (this.phase !== 'lobby') return fail('notAllowed', "Can't change that now.");
    if (this.players.length >= MAX_PLAYERS) return fail('full', 'This room is full.');
    if (this.find(guestId)) return fail('notAllowed', 'That id is taken.');
    this.players.push({
      id: guestId, name, ready: true, level: 5, speed: 'med', connected: host.connected, voice: false, cpu: null, runBy: null, guestOf: id,
    });
    return ok(undefined);
  }

  /** A person changes one of their couch guests' name, level or speed (unset fields stay as they are). */
  setGuest(id: string, guestId: string, change: { name?: string; level?: number; speed?: Speed }): Result {
    const g = this.find(guestId);
    if (!g || g.guestOf !== id || this.phase !== 'lobby') return fail('notAllowed', "Can't change that now.");
    if (change.name !== undefined) g.name = change.name;
    if (change.level !== undefined) g.level = change.level;
    if (change.speed !== undefined) g.speed = change.speed;
    return ok(undefined);
  }

  removeGuest(id: string, guestId: string): Result {
    const g = this.find(guestId);
    if (!g || g.guestOf !== id || this.phase !== 'lobby') return fail('notAllowed', "Can't change that now.");
    this.players = this.players.filter(x => x.id !== guestId);
    return ok(undefined);
  }

  /** `id`'s couch guests (their ids). */
  guestsOf(id: string): string[] {
    return this.guests(id).map(g => g.id);
  }

  /**
   * True if `id`'s browser plays `seatId` in the current match: a CPU it was given, or one of its
   * couch guests. (So it may send that seat's board, garbage and result.)
   */
  playsFor(id: string, seatId: string): boolean {
    const p = this.find(seatId);
    return this.inMatch && !!p && (p.guestOf === id || (!!p.cpu && p.runBy === id));
  }

  /** True if `id`'s browser plays CPU `cpuId` in the current match. */
  runsCpu(id: string, cpuId: string): boolean {
    const p = this.find(cpuId);
    return this.inMatch && !!p?.cpu && p.runBy === id;
  }

  /** The CPUs `id`'s browser plays in the current match. */
  cpusRunBy(id: string): string[] {
    return this.inMatch ? this.players.filter(p => p.cpu && p.runBy === id).map(p => p.id) : [];
  }

  /** The person whose browser plays this seat for it: a CPU's runner or a guest's host (null for a person, or nobody). */
  runnerOf(seatId: string): string | null {
    const p = this.find(seatId);
    return p?.runBy ?? p?.guestOf ?? null;
  }

  /**
   * Spread the CPUs over the people who are here: each CPU goes to whoever runs the fewest so
   * far, so with two people and two CPUs each runs one. Ties go round the seats, starting one
   * seat later each round, so a lone CPU isn't always on the host's browser. A browser with couch
   * guests already has that many boards to run, so it counts as that busy from the start.
   */
  private assignCpus(): void {
    const here = this.players.filter(p => this.isPerson(p) && p.connected);
    const shift = here.length ? ((this.match?.round ?? 1) - 1) % here.length : 0;
    const people = [...here.slice(shift), ...here.slice(0, shift)];
    const load = new Map(people.map(p => [p.id, this.guests(p.id).length]));
    for (const cpu of this.players.filter(p => p.cpu)) {
      let best: string | null = null;
      for (const person of people) if (best === null || load.get(person.id)! < load.get(best)!) best = person.id;
      cpu.runBy = best;
      if (best) load.set(best, load.get(best)! + 1);
    }
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
   * Free their seat for good, and their couch guests' seats. If they were host, the next person
   * becomes host. A match carries on without them while at least two players are left.
   */
  remove(id: string): void {
    const gone = new Set([id, ...this.guestsOf(id)]);
    this.players = this.players.filter(p => !gone.has(p.id));
    if (!this.players.some(p => this.isPerson(p))) this.players = []; // only CPUs left: the room is empty
    if (this.hostId === id) this.hostId = this.players.find(p => this.isPerson(p))?.id ?? null;
    if (this.match) {
      for (const g of gone) {
        delete this.match.wins[g];
        this.match.out.delete(g);
      }
      if (this.players.length < MIN_PLAYERS) this.backToLobby();
    }
  }

  nameOf(id: string): string {
    return this.find(id)?.name ?? 'Player';
  }

  get isEmpty(): boolean {
    return this.players.every(p => !this.isPerson(p) || !p.connected);
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
    this.assignCpus();
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
    this.assignCpus(); // someone may have left since last round
    return this.startInfo(seed);
  }

  /**
   * A player didn't come back in time. With two players the other one wins the match; with
   * more, they're knocked out of this round (and their seat is freed afterwards, see remove).
   */
  abandon(id: string): Report | null {
    const m = this.match;
    if (!this.inMatch || !m) return null;
    const p = this.find(id);
    if (this.players.length <= 2 && p && this.isPerson(p)) {
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
    for (const p of this.players) {
      p.ready = !this.isPerson(p); // CPUs and couch guests are always ready
      p.runBy = null;
    }
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
      players: this.players.map(({ id, name, level, speed, cpu, runBy, guestOf }) => ({ id, name, level, speed, cpu, runBy, guestOf })),
      settings: this.settings,
      round: this.match!.round,
      wins: { ...this.match!.wins },
    };
  }

  /** Someone with their own browser (not a CPU or a couch guest). */
  private isPerson(p: LobbyPlayer): boolean {
    return !p.cpu && !p.guestOf;
  }

  private guests(id: string): LobbyPlayer[] {
    return this.players.filter(p => p.guestOf === id);
  }

  private find(id: string): LobbyPlayer | undefined {
    return this.players.find(p => p.id === id);
  }
}
