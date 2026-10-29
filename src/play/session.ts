import { CpuSkillName } from '../config';
import { CpuController } from '../core/ai';
import { Game } from '../core/game';
import { Match } from '../core/match';
import { Rumble } from '../input/rumble';
import { KeyboardInput } from '../input/keyboard';
import { BoardSnapshot, RoundResult, StartInfo } from '../net/protocol';

/** A seat in a match on this computer: a person with their own input, or a CPU. */
export type Seat =
  | { kind: 'person'; input: KeyboardInput; rumble: Rumble }
  | { kind: 'cpu'; ai: CpuController; skill: CpuSkillName };

/** What's being played right now. */
export type Session =
  | { kind: 'solo'; game: Game }
  | CpuSession
  | OnlineSession;

/** Vs CPU and local matches. startAt = end of the 3-2-1 countdown before each round. */
export interface CpuSession {
  kind: 'cpu';
  match: Match;
  seats: Seat[];
  startAt: number;
  local: boolean;
}

/** An opponent in an online round: their latest board snapshot and whether they're knocked out. */
export interface OnlineOpponent {
  id: string;
  name: string;
  /** A CPU that this browser plays (its board comes from our worker, not the server). */
  mine: boolean;
  snap: BoardSnapshot | null;
  /** When we last heard from them. */
  at: number;
  out: boolean;
}

/** A couch guest playing on this browser in an online round: their own board, controller and rumble. */
export interface OnlineGuest {
  id: string;
  name: string;
  game: Game;
  input: KeyboardInput;
  rumble: Rumble;
  /** Their controller (null if it's gone missing). */
  pad: number | null;
  resultSent: boolean;
  lastSent: { json: string; at: number };
}

/**
 * An online round: your board runs here, and your couch guests' boards (none in most rooms);
 * the opponents' (1–3) arrive as snapshots.
 */
export interface OnlineSession {
  kind: 'online';
  game: Game;
  /** This browser's couch guests (empty without any). */
  guests: OnlineGuest[];
  /** Your rumble (with guests on this screen: only your own controller, not theirs). */
  rumble: Rumble;
  info: StartInfo;
  /** Opponents in seating order. */
  opps: OnlineOpponent[];
  /** Play (re)starts at this time: after the start countdown, a pause or a reconnect. */
  startAt: number;
  /** Shared pause: who paused (null if not paused). */
  pausedBy: string | null;
  /** An opponent's connection dropped: they have until `until` to come back. */
  away: { name: string; until: number } | null;
  /** The round's result from the server, once decided. */
  result: RoundResult | null;
  resultSent: boolean;
  lastSent: { json: string; at: number };
}

/**
 * No word from the opponent for this long: pause both boards ("Connection problem…").
 * Background tabs only get timers about once a second, so keep this well above that.
 */
export const STALE_MS = 3500;

export type OnlineHold = 'result' | 'over' | 'reconnecting' | 'away' | 'paused' | 'stale' | 'countdown';

/** An online round with couch guests on this screen (everyone on it is shown equal, by name). */
export const hasGuests = (s: Session | null): s is OnlineSession => s?.kind === 'online' && s.guests.length > 0;

/** Your own board in a session. */
export function yourGame(s: Session | null): Game | null {
  if (!s) return null;
  return s.kind === 'cpu' ? s.match.games[0] : s.game;
}

/** Why an online round isn't advancing right now, or null if it is. */
export function onlineHold(s: OnlineSession, now: number, connected: boolean): OnlineHold | null {
  if (s.result) return 'result';
  if (s.game.isOver && s.guests.every(g => g.game.isOver)) return 'over'; // everyone on this screen is done
  if (!connected) return 'reconnecting';
  if (s.away) return 'away';
  if (s.pausedBy) return 'paused';
  if (staleOpponent(s, now)) return 'stale';
  if (now < s.startAt) return 'countdown';
  return null;
}

/**
 * The CPUs this browser plays wait while the round is held for everyone (paused, someone away
 * or quiet, round decided), but keep playing if your own board is over.
 */
export function cpuHold(s: OnlineSession, now: number, connected: boolean): boolean {
  return !!s.result || !connected || !!s.away || !!s.pausedBy || !!staleOpponent(s, now);
}

/** An opponent still in the round that we haven't heard from for a while (null if none). */
export function staleOpponent(s: OnlineSession, now: number): OnlineOpponent | null {
  return s.opps.find(o => !o.out && now - o.at > STALE_MS) ?? null;
}
