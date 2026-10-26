// Plays the CPU players this browser runs in an online match. In a worker (not the page) so
// they keep playing at full speed even if this tab is in the background.

import { BOARD_SNAPSHOT_HZ, CPU_SKILLS, CpuSkillName, MAX_FRAME_MS, SIM_STEP_MS, Speed } from '../config';
import { CpuController } from '../core/ai';
import { Game } from '../core/game';
import { Color } from '../core/types';
import { BoardSnapshot, Outcome } from './protocol';
import { encodeSnapshot } from './snapshot';

export interface CpuSpec {
  id: string;
  level: number;
  speed: Speed;
  skill: CpuSkillName;
  /** The round's shared seed (same germs and capsules as everyone). */
  seed: number;
  /** The AI's own randomness. */
  aiSeed: number;
  fastGarbage: boolean;
}

/** Times are epoch milliseconds, since the page's and the worker's clocks start at different moments. */
export type ToWorker =
  | { type: 'start'; cpus: CpuSpec[]; startAt: number }
  | { type: 'sync'; hold: boolean; startAt: number }
  | { type: 'garbage'; id: string; colors: Color[] }
  | { type: 'stop' };

export type FromWorker =
  | { type: 'board'; id: string; snap: BoardSnapshot }
  | { type: 'garbage'; id: string; colors: Color[]; firstColors: Color[] }
  | { type: 'over'; id: string; outcome: Outcome };

/** Send a board at least this often even if nothing changed (it doubles as a heartbeat). */
const KEEPALIVE_MS = 500;

interface Cpu {
  id: string;
  game: Game;
  ai: CpuController;
  over: boolean;
  lastSent: { json: string; at: number };
}

/** The worker's global scope (typed by hand: the project's types are for pages). */
const scope = self as unknown as { postMessage(msg: FromWorker): void; onmessage: ((e: MessageEvent<ToWorker>) => void) | null };
const now = () => performance.timeOrigin + performance.now();
const post = (msg: FromWorker) => scope.postMessage(msg);

let cpus: Cpu[] = [];
/** Paused, waiting for someone, or the round is decided. */
let hold = true;
/** Play (re)starts at this time (after a countdown). */
let startAt = 0;
let acc = 0;
let last = now();

scope.onmessage = (e: MessageEvent<ToWorker>) => {
  const msg = e.data;
  switch (msg.type) {
    case 'start':
      cpus = msg.cpus.map(spec => ({
        id: spec.id,
        game: new Game({ level: spec.level, speed: spec.speed, seed: spec.seed, fastGarbage: spec.fastGarbage, playerSalt: spec.id }),
        ai: new CpuController(CPU_SKILLS[spec.skill], spec.aiSeed),
        over: false,
        lastSent: { json: '', at: 0 },
      }));
      hold = false;
      startAt = msg.startAt;
      acc = 0;
      sendBoards(now(), true);
      break;
    case 'sync':
      hold = msg.hold;
      startAt = msg.startAt;
      break;
    case 'garbage': {
      const cpu = cpus.find(c => c.id === msg.id);
      if (cpu && !cpu.over) cpu.game.receiveGarbage(msg.colors);
      break;
    }
    case 'stop':
      cpus = [];
      break;
  }
};

setInterval(() => {
  const t = now();
  const dt = Math.min(t - last, MAX_FRAME_MS);
  last = t;
  if (cpus.length === 0) return;
  if (hold || t < startAt) {
    acc = 0;
  } else {
    acc += dt;
    while (acc >= SIM_STEP_MS) {
      acc -= SIM_STEP_MS;
      for (const cpu of cpus) if (!cpu.over) step(cpu);
    }
  }
  sendBoards(t, false);
}, 8);

function step(cpu: Cpu): void {
  const { game } = cpu;
  game.step(SIM_STEP_MS, cpu.ai.poll(game, SIM_STEP_MS));
  for (const e of game.drainEvents()) {
    if (e.type === 'garbageOut') post({ type: 'garbage', id: cpu.id, colors: e.colors, firstColors: e.firstColors });
  }
  if (game.isOver) {
    cpu.over = true;
    post({ type: 'board', id: cpu.id, snap: encodeSnapshot(game) });
    post({ type: 'over', id: cpu.id, outcome: game.phase === 'won' ? 'cleared' : 'toppedOut' });
  }
}

/** Each CPU's board when it changed (at most BOARD_SNAPSHOT_HZ), or anyway every so often. */
function sendBoards(t: number, force: boolean): void {
  for (const cpu of cpus) {
    if (!force && t - cpu.lastSent.at < 1000 / BOARD_SNAPSHOT_HZ) continue;
    const snap = encodeSnapshot(cpu.game);
    const json = JSON.stringify(snap);
    if (force || json !== cpu.lastSent.json || t - cpu.lastSent.at >= KEEPALIVE_MS) {
      post({ type: 'board', id: cpu.id, snap });
      cpu.lastSent = { json, at: t };
    }
  }
}
