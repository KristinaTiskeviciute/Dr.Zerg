// Messages between the browser and the relay server. Shared by both sides.
// The server never simulates the game: it keeps room state (players, host, settings, seed)
// and passes messages along.

import { CPU_SKILLS, CpuSkillName, MAX_LEVEL, MIN_LEVEL, Speed } from '../config';

export const MAX_PLAYERS = 4;
export const MIN_PLAYERS = 2;
export const MAX_NAME_LENGTH = 16;
export const START_COUNTDOWN_MS = 3000;
/** Countdown when play resumes after a pause or a reconnect. */
export const RESUME_COUNTDOWN_MS = 3000;
/**
 * Break between rounds before the next round's countdown starts: the boards stay up for a
 * moment (ROUND_END_LINGER_MS), then the result shows (time to chat).
 */
export const ROUND_BREAK_MS = 6000;
export const MAX_CHAT_LENGTH = 120;
/** Chat lines a room remembers (sent to anyone who joins or reconnects). */
export const CHAT_HISTORY = 30;
/** Emotes everyone can pop up big on the screen; sent by index. */
export const EMOTES = ['😭', '😂', '😱', '😡', '😎', '👏', '🔥', '💀'] as const;
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
/** Why a round ended. With 3–4 players a round that ends by knock-outs is 'lastStanding' (by = the winner). */
export type RoundReason = Outcome | 'disconnect' | 'lastStanding';

export interface LobbyPlayer {
  id: string;
  name: string;
  ready: boolean;
  level: number;
  speed: Speed;
  connected: boolean;
  /** In the voice chat. */
  voice: boolean;
  /** A CPU player (its skill), or null for a person. CPUs are always ready. */
  cpu: CpuSkillName | null;
  /** CPUs: which person's browser plays this CPU in the current match (null in the lobby). */
  runBy: string | null;
}

export interface RoomSettings {
  fastGarbage: boolean;
  /** Outbreak mode (3–4 players): every chain's garbage goes to all other players. */
  outbreak: boolean;
}

export interface LobbyState {
  code: string;
  hostId: string | null;
  players: LobbyPlayer[];
  settings: RoomSettings;
  phase: 'lobby' | 'playing';
}

export interface ChatLine {
  from: string;
  /** The sender's name when they said it. */
  name: string;
  text: string;
}

/**
 * Voice chat setup between two browsers (WebRTC), passed along by the server: a session
 * description (offer/answer) or a network address candidate. The audio itself goes directly
 * between the players (or through a TURN relay), never through the room server.
 */
export type RtcSignal =
  | { sdp: { type: 'offer' | 'answer'; sdp: string } }
  | { candidate: { candidate: string; sdpMid?: string | null; sdpMLineIndex?: number | null; usernameFragment?: string | null } };

export type ClientMessage =
  | { t: 'join'; playerId: string; name: string }
  | { t: 'setup'; level: number; speed: Speed }
  | { t: 'ready'; ready: boolean }
  /** Host changes one or more room settings. */
  | { t: 'settings'; fastGarbage?: boolean; outbreak?: boolean }
  | { t: 'start' }
  | { t: 'backToLobby' }
  /** After a match: ready for another; it starts as soon as everyone has said so. */
  | { t: 'playAgain' }
  /** Host: add a CPU player, change one (unset fields stay), or remove one. Lobby only. */
  | { t: 'addCpu' }
  | { t: 'cpu'; id: string; level?: number; speed?: Speed; skill?: CpuSkillName }
  | { t: 'removeCpu'; id: string }
  /** Chat and emotes (only offered outside of play: lobby, pause, between rounds). */
  | { t: 'chat'; text: string }
  | { t: 'emote'; e: number }
  /** Joined or left the voice chat. */
  | { t: 'voice'; on: boolean }
  /** Voice chat setup for one other player. */
  | { t: 'rtc'; to: string; data: RtcSignal }
  // During a match. `as`: sent on behalf of a CPU this browser plays.
  | { t: 'board'; snap: BoardSnapshot; as?: string }
  /** firstColors = the colors of the chain's first clear; the server uses them to pick targets. */
  | { t: 'garbage'; colors: number[]; firstColors: number[]; as?: string }
  | { t: 'result'; outcome: Outcome; as?: string }
  | { t: 'pause'; paused: boolean };

export interface StartInfo {
  seed: number;
  /** Start after this long (relative, so clocks don't need to agree). */
  startInMs: number;
  players: { id: string; name: string; level: number; speed: Speed; cpu: CpuSkillName | null; runBy: string | null }[];
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
  | ({ t: 'chat' } & ChatLine)
  /** The room's recent chat, sent when you join (or rejoin). */
  | { t: 'chatLog'; lines: ChatLine[] }
  | { t: 'emote'; from: string; name: string; e: number }
  | { t: 'rtc'; from: string; data: RtcSignal }
  // During a match:
  | { t: 'board'; from: string; snap: BoardSnapshot }
  /** Garbage for you, or (to) for a CPU your browser plays. */
  | { t: 'garbage'; from: string; colors: number[]; to?: string }
  /** A player was knocked out of the round (topped out, left the round, or gone for good). */
  | { t: 'out'; id: string; reason: Outcome | 'disconnect' }
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

/** Chat text without control characters, trimmed and cut to MAX_CHAT_LENGTH (null if nothing's left). */
export function cleanChat(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const s = raw.replace(/[\u0000-\u001f\u007f]/g, ' ').trim();
  // Cut by characters, not UTF-16 units, so an emoji isn't split in half.
  return Array.from(s).slice(0, MAX_CHAT_LENGTH).join('').trim() || null;
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
      return isPlayerId(m.playerId)
        ? { t: 'join', playerId: m.playerId, name: cleanName(m.name) }
        : null;
    case 'setup':
      return isLevel(m.level) && isSpeed(m.speed) ? { t: 'setup', level: m.level, speed: m.speed } : null;
    case 'ready':
      return typeof m.ready === 'boolean' ? { t: 'ready', ready: m.ready } : null;
    case 'settings': {
      const fg = typeof m.fastGarbage === 'boolean' ? m.fastGarbage : undefined;
      const ob = typeof m.outbreak === 'boolean' ? m.outbreak : undefined;
      if (fg === undefined && ob === undefined) return null;
      return { t: 'settings', ...(fg !== undefined && { fastGarbage: fg }), ...(ob !== undefined && { outbreak: ob }) };
    }
    case 'start':
      return { t: 'start' };
    case 'backToLobby':
      return { t: 'backToLobby' };
    case 'playAgain':
      return { t: 'playAgain' };
    case 'chat': {
      const text = cleanChat(m.text);
      return text ? { t: 'chat', text } : null;
    }
    case 'emote':
      return isInt(m.e, 0, EMOTES.length - 1) ? { t: 'emote', e: m.e } : null;
    case 'voice':
      return typeof m.on === 'boolean' ? { t: 'voice', on: m.on } : null;
    case 'rtc':
      return isPlayerId(m.to) && isRtcSignal(m.data) ? { t: 'rtc', to: m.to, data: m.data } : null;
    case 'addCpu':
      return { t: 'addCpu' };
    case 'cpu': {
      if (!isPlayerId(m.id)) return null;
      if (m.level !== undefined && !isLevel(m.level)) return null;
      if (m.speed !== undefined && !isSpeed(m.speed)) return null;
      if (m.skill !== undefined && !isSkill(m.skill)) return null;
      return {
        t: 'cpu', id: m.id,
        ...(m.level !== undefined && { level: m.level as number }),
        ...(m.speed !== undefined && { speed: m.speed as Speed }),
        ...(m.skill !== undefined && { skill: m.skill as CpuSkillName }),
      };
    }
    case 'removeCpu':
      return isPlayerId(m.id) ? { t: 'removeCpu', id: m.id } : null;
    case 'board':
      if (!isAs(m.as)) return null;
      return isSnapshot(m.snap) ? { t: 'board', snap: m.snap, ...(m.as !== undefined && { as: m.as }) } : null;
    case 'garbage': {
      const colorList = (v: unknown, max: number): v is number[] =>
        Array.isArray(v) && v.length >= 1 && v.length <= max && v.every(isColor);
      if (!isAs(m.as)) return null;
      return colorList(m.colors, 4) && colorList(m.firstColors, 3)
        ? { t: 'garbage', colors: m.colors, firstColors: m.firstColors, ...(m.as !== undefined && { as: m.as }) }
        : null;
    }
    case 'result':
      if (!isAs(m.as)) return null;
      return m.outcome === 'cleared' || m.outcome === 'toppedOut' || m.outcome === 'forfeit'
        ? { t: 'result', outcome: m.outcome, ...(m.as !== undefined && { as: m.as }) }
        : null;
    case 'pause':
      return typeof m.paused === 'boolean' ? { t: 'pause', paused: m.paused } : null;
    default:
      return null;
  }
}

const isSkill = (v: unknown): v is CpuSkillName => typeof v === 'string' && v in CPU_SKILLS;
/** Optional "on behalf of this CPU" id. */
const isAs = (v: unknown) => v === undefined || isPlayerId(v);
const isPlayerId = (v: unknown): v is string => typeof v === 'string' && /^[A-Za-z0-9_-]{6,64}$/.test(v);
const isShortString = (v: unknown, max: number): v is string => typeof v === 'string' && v.length <= max;
const isOptional = (v: unknown, check: (v: unknown) => boolean) => v === undefined || v === null || check(v);

/** Voice setup messages are relayed as-is, so check their shape and size. */
export function isRtcSignal(d: unknown): d is RtcSignal {
  if (!isObj(d)) return false;
  if (isObj(d.sdp)) {
    return Object.keys(d).length === 1 && (d.sdp.type === 'offer' || d.sdp.type === 'answer')
      && isShortString(d.sdp.sdp, 20000) && Object.keys(d.sdp).length === 2;
  }
  if (isObj(d.candidate)) {
    const c = d.candidate;
    return Object.keys(d).length === 1 && isShortString(c.candidate, 1000)
      && isOptional(c.sdpMid, v => isShortString(v, 64))
      && isOptional(c.sdpMLineIndex, v => isInt(v, 0, 64))
      && isOptional(c.usernameFragment, v => isShortString(v, 256))
      && Object.keys(c).every(k => ['candidate', 'sdpMid', 'sdpMLineIndex', 'usernameFragment'].includes(k));
  }
  return false;
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
