// Messages between the browser and the relay server. Shared by both sides.
// The server never simulates the game: it keeps room state (players, host, settings, seed)
// and passes messages along.

import { MAX_LEVEL, MIN_LEVEL, Speed } from '../config';

export const MAX_PLAYERS = 2;
export const MAX_NAME_LENGTH = 16;
export const START_COUNTDOWN_MS = 3000;
const SPEEDS: readonly Speed[] = ['low', 'med', 'high'];

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
  | { t: 'backToLobby' };

export interface StartInfo {
  seed: number;
  /** Start after this long (relative, so clocks don't need to agree). */
  startInMs: number;
  players: { id: string; name: string; level: number; speed: Speed }[];
  settings: RoomSettings;
}

export type ErrorCode = 'full' | 'inProgress' | 'badMessage' | 'notAllowed';

export type ServerMessage =
  | { t: 'lobby'; lobby: LobbyState }
  | ({ t: 'start' } & StartInfo)
  | { t: 'error'; code: ErrorCode; message: string };

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
    default:
      return null;
  }
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
