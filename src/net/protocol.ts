// Messages between the browser and the relay server. Shared by both sides.
// The server never simulates the game: it keeps room state (players, host, settings, seed)
// and passes messages along.

import { MAX_LEVEL, MIN_LEVEL, Speed } from '../config';

export const MAX_PLAYERS = 2;
export const MAX_NAME_LENGTH = 16;
export const START_COUNTDOWN_MS = 3000;
/** Countdown when play resumes after a pause or a reconnect. */
export const RESUME_COUNTDOWN_MS = 3000;
/** Break between rounds (showing the result) before the next round's countdown starts. */
export const ROUND_BREAK_MS = 4000;
const SPEEDS: readonly Speed[] = ['low', 'med', 'high'];
const BOARD_CELLS = 8 * 16;

/**
 * A compact picture of one player's board, sent ~10×/s so the other player can draw it.
 * c: one character per cell (see src/net/snapshot.ts), a: falling capsule [row, col, orientation, colorA, colorB],
 * n: next capsule colors, k: cells currently popping, p: pop progress 0–1, q: queued garbage colors ("012…"), g: germs left.
 */
export interface BoardSnapshot {
  c: string;
  a: [number, number, number, number, number] | null;
  n: [number, number] | null;
  k: number[];
  p: number;
  q: string;
  g: number;
}

/** How a player's round ended: they cleared their bottle, topped out, or forfeited (e.g. reloaded mid-round). */
export type Outcome = 'cleared' | 'toppedOut' | 'forfeit';
export type RoundReason = Outcome | 'disconnect';

export interface LobbyPlayer {
  id: string;
  name: string;
  ready: boolean;
  level: number;
  speed: Speed;
  connected: boolean;
}

export interface RoomSettings {
  fastGarbage: boolean;
}

export interface LobbyState {
  code: string;
  hostId: string | null;
  players: LobbyPlayer[];
  settings: RoomSettings;
  phase: 'lobby' | 'playing';
}

export type ClientMessage =
  | { t: 'join'; playerId: string; name: string }
  | { t: 'setup'; level: number; speed: Speed }
  | { t: 'ready'; ready: boolean }
  | { t: 'settings'; fastGarbage: boolean }
  | { t: 'start' }
  | { t: 'backToLobby' }
  // During a match:
  | { t: 'board'; snap: BoardSnapshot }
  | { t: 'garbage'; colors: number[] }
  | { t: 'result'; outcome: Outcome }
  | { t: 'pause'; paused: boolean };

export interface StartInfo {
  seed: number;
  /** Start after this long (relative, so clocks don't need to agree). */
  startInMs: number;
  players: { id: string; name: string; level: number; speed: Speed }[];
  settings: RoomSettings;
  /** Round number in this match (1, 2, 3) and round wins so far, by player id. */
  round: number;
  wins: Record<string, number>;
}

export interface RoundResult {
  /** null = nobody (shouldn't normally happen). */
  winner: string | null;
  reason: RoundReason;
  /** Who the reason is about (e.g. who topped out or cleared). */
  by: string;
  wins: Record<string, number>;
  matchOver: boolean;
  /** When the next round's start message comes (null if the match is over). */
  nextInMs: number | null;
}

export type ErrorCode = 'full' | 'inProgress' | 'badMessage' | 'notAllowed';

export type ServerMessage =
  | { t: 'lobby'; lobby: LobbyState }
  | ({ t: 'start' } & StartInfo)
  | { t: 'error'; code: ErrorCode; message: string }
  // During a match:
  | { t: 'board'; from: string; snap: BoardSnapshot }
  | { t: 'garbage'; from: string; colors: number[] }
  | ({ t: 'round' } & RoundResult)
  /** Shared pause. On unpause, play resumes after resumeInMs. */
  | { t: 'pause'; paused: boolean; by: string; resumeInMs: number }
  /** A player's connection dropped mid-match; they have graceMs to come back. */
  | { t: 'away'; id: string; name: string; graceMs: number }
  | { t: 'back'; id: string; resumeInMs: number };

// --- Validation (the server trusts nothing it receives) ---

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null;
const isLevel = (v: unknown): v is number => Number.isInteger(v) && (v as number) >= MIN_LEVEL && (v as number) <= MAX_LEVEL;
const isSpeed = (v: unknown): v is Speed => typeof v === 'string' && (SPEEDS as string[]).includes(v);

export function cleanName(raw: unknown): string {
  const s = typeof raw === 'string' ? raw.replace(/[\u0000-\u001f]/g, '').trim() : '';
  return s.slice(0, MAX_NAME_LENGTH) || 'Player';
}

export function parseClientMessage(raw: string): ClientMessage | null {
  let m: unknown;
  try {
    m = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!isObj(m)) return null;
  switch (m.t) {
    case 'join':
      return typeof m.playerId === 'string' && /^[A-Za-z0-9_-]{6,64}$/.test(m.playerId)
        ? { t: 'join', playerId: m.playerId, name: cleanName(m.name) }
        : null;
    case 'setup':
      return isLevel(m.level) && isSpeed(m.speed) ? { t: 'setup', level: m.level, speed: m.speed } : null;
    case 'ready':
      return typeof m.ready === 'boolean' ? { t: 'ready', ready: m.ready } : null;
    case 'settings':
      return typeof m.fastGarbage === 'boolean' ? { t: 'settings', fastGarbage: m.fastGarbage } : null;
    case 'start':
      return { t: 'start' };
    case 'backToLobby':
      return { t: 'backToLobby' };
    case 'board':
      return isSnapshot(m.snap) ? { t: 'board', snap: m.snap } : null;
    case 'garbage':
      return Array.isArray(m.colors) && m.colors.length >= 1 && m.colors.length <= 4 && m.colors.every(isColor)
        ? { t: 'garbage', colors: m.colors as number[] }
        : null;
    case 'result':
      return m.outcome === 'cleared' || m.outcome === 'toppedOut' || m.outcome === 'forfeit'
        ? { t: 'result', outcome: m.outcome }
        : null;
    case 'pause':
      return typeof m.paused === 'boolean' ? { t: 'pause', paused: m.paused } : null;
    default:
      return null;
  }
}

const isInt = (v: unknown, min: number, max: number): v is number =>
  Number.isInteger(v) && (v as number) >= min && (v as number) <= max;
const isColor = (v: unknown): v is number => isInt(v, 0, 2);

/** Board snapshots are relayed as-is, so check their shape and size strictly. */
export function isSnapshot(s: unknown): s is BoardSnapshot {
  if (!isObj(s)) return false;
  if (typeof s.c !== 'string' || s.c.length !== BOARD_CELLS || !/^[.a-s]+$/.test(s.c)) return false;
  if (s.a !== null) {
    if (!Array.isArray(s.a) || s.a.length !== 5) return false;
    const [row, col, o, ca, cb] = s.a;
    if (!isInt(row, -1, 15) || !isInt(col, 0, 7) || !isInt(o, 0, 3) || !isColor(ca) || !isColor(cb)) return false;
  }
  if (s.n !== null && !(Array.isArray(s.n) && s.n.length === 2 && s.n.every(isColor))) return false;
  if (!Array.isArray(s.k) || s.k.length > BOARD_CELLS || !s.k.every(i => isInt(i, 0, BOARD_CELLS - 1))) return false;
  if (typeof s.p !== 'number' || !(s.p >= 0 && s.p <= 1)) return false;
  if (typeof s.q !== 'string' || s.q.length > 32 || !/^[012]*$/.test(s.q)) return false;
  return isInt(s.g, 0, BOARD_CELLS);
}

// --- Room codes ---

/** Letters that can't be confused with each other or with digits (no I, L, O). */
const CODE_LETTERS = 'ABCDEFGHJKMNPQRSTUVWXYZ';
export const ROOM_CODE_LENGTH = 4;

export function makeRoomCode(random: () => number = Math.random): string {
  let code = '';
  for (let i = 0; i < ROOM_CODE_LENGTH; i++) code += CODE_LETTERS[Math.floor(random() * CODE_LETTERS.length)];
  return code;
}

export function normalizeRoomCode(raw: string): string | null {
  const code = raw.trim().toUpperCase();
  return new RegExp(`^[${CODE_LETTERS}]{${ROOM_CODE_LENGTH}}$`).test(code) ? code : null;
}
