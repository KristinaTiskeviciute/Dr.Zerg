import {
  BOARD_COLS,
  BOARD_ROWS,
  CLEAR_ANIMATION_MS,
  ENTRY_DELAY_MS,
  FALL_INTERVAL_MS,
  FAST_GARBAGE_MULTIPLIER,
  GARBAGE_FALL_STEP_MS,
  GRAVITY_STEP_MS,
  LOCK_DELAY_MS,
  MIN_FALL_INTERVAL_MS,
  SOFT_DROP_MULTIPLIER,
  SPEEDUP_EVERY_N_CAPSULES,
  SPEEDUP_FACTOR,
  Speed,
} from '../config';
import { Board } from './board';
import { Capsule, capsuleHalves, fits, tryMove, tryRotate } from './capsule';
import { garbageForChain, pickGarbageColumns } from './garbage';
import { placeGerms } from './germs';
import { PieceSequence } from './pieces';
import { deriveSeed, Rng } from './rng';
import { Color, Pos } from './types';

export type Phase = 'falling' | 'clearing' | 'settling' | 'garbage' | 'won' | 'lost';

export interface GameOptions {
  level: number;
  speed: Speed;
  /** Shared seed: same seed + level → same germs and capsule sequence. */
  seed: number;
  fastGarbage?: boolean;
  /** Makes this board's garbage placement independent of other players'. */
  playerSalt?: string;
  /** Tests: set up the board yourself instead of placing germs. */
  setupBoard?: (board: Board) => void;
}

/** Input for one simulation step. Moves/rotations are one-shot; softDrop is held. */
export interface StepInput {
  left?: boolean;
  right?: boolean;
  /** Left/right is being held down (a blocked held move is retried every step, so it slides into gaps). */
  holdLeft?: boolean;
  holdRight?: boolean;
  /**
   * Down is physically held, even one held over from the previous capsule (which softDrop
   * ignores). Used for Fast garbage speed-ups after the capsule locks. Defaults to softDrop.
   */
  downHeld?: boolean;
  rotateCW?: boolean;
  rotateCCW?: boolean;
  softDrop?: boolean;
}

export type GameEvent =
  | { type: 'spawn' }
  | { type: 'move' }
  | { type: 'rotate' }
  | { type: 'lock'; cells: Pos[] }
  /** Capsules now fall faster (every SPEEDUP_EVERY_N_CAPSULES). step = how many speed-ups so far. */
  | { type: 'speedUp'; step: number }
  | { type: 'clear'; chain: number; lines: number; cells: Pos[]; germs: number }
  /** colors = the garbage pieces; firstColors = the colors of the chain's first clear (they pick targets with 3–4 players). */
  | { type: 'garbageOut'; colors: Color[]; firstColors: Color[] }
  | { type: 'garbageIn'; count: number }
  | { type: 'garbageLanded' }
  | { type: 'won' }
  | { type: 'lost' };

export class Game {
  readonly board = new Board(BOARD_COLS, BOARD_ROWS);
  readonly level: number;
  readonly speed: Speed;
  readonly fastGarbage: boolean;

  phase: Phase = 'falling';
  active: Capsule | null = null;
  /** Index of the current capsule in the shared sequence (= capsules locked so far). */
  pieceIndex = 0;
  /** Cells currently popping (during 'clearing'). */
  clearingCells: Pos[] = [];
  /** 0–1 progress of the current clear animation. */
  clearProgress = 0;

  private readonly pieces: PieceSequence;
  private readonly garbageRng: Rng;
  private readonly garbageQueue: Color[][] = [];
  private events: GameEvent[] = [];

  private fallTimer = 0;
  private lockTimer = 0;
  /** Time left that a freshly spawned capsule hangs at the top before gravity starts. */
  private spawnHold = 0;
  /** A held left/right that was blocked: retried every step until it goes through. */
  private pushing: 'left' | 'right' | null = null;
  private phaseTimer = 0;
  private chainStep = 0;
  private chainLineColors: Color[] = [];
  private chainFirstColors: Color[] = [];
  /** True while resolving clears caused by incoming garbage (those don't send garbage back). */
  private resolvingGarbage = false;
  /**
   * A capsule half that locked up in the neck (above the bottle). It drops in once the
   * board has settled, if there's room by then; if not, the player has topped out.
   */
  private overflow: { col: number; color: Color } | null = null;

  constructor(opts: GameOptions) {
    this.level = opts.level;
    this.speed = opts.speed;
    this.fastGarbage = opts.fastGarbage ?? false;
    this.pieces = new PieceSequence(deriveSeed(opts.seed, 'pieces'));
    this.garbageRng = new Rng(deriveSeed(opts.seed, 'garbage:' + (opts.playerSalt ?? '')));
    if (opts.setupBoard) opts.setupBoard(this.board);
    else placeGerms(this.board, opts.level, new Rng(deriveSeed(opts.seed, 'germs')));
    this.spawn();
  }

  /** The capsule that will spawn next. Between lock and spawn (clears, garbage) that's pieceIndex itself. */
  get nextColors(): readonly [Color, Color] {
    return this.pieces.colorsAt(this.active ? this.pieceIndex + 1 : this.pieceIndex);
  }

  get germsLeft(): number {
    return this.board.germCount();
  }

  get isOver(): boolean {
    return this.phase === 'won' || this.phase === 'lost';
  }

  get pendingGarbage(): number {
    return this.garbageQueue.reduce((n, a) => n + a.length, 0);
  }

  /** Colors of all queued garbage pieces, oldest attack first (for the incoming preview). */
  get queuedGarbage(): Color[] {
    return this.garbageQueue.flat();
  }

  /** How many times the fall speed has gone up this game. */
  get speedStep(): number {
    return Math.floor(this.pieceIndex / SPEEDUP_EVERY_N_CAPSULES);
  }

  fallIntervalMs(): number {
    return Math.max(MIN_FALL_INTERVAL_MS, FALL_INTERVAL_MS[this.speed] * SPEEDUP_FACTOR ** this.speedStep);
  }

  /** Queue an opponent's attack. It drops after the current capsule locks and settles. */
  receiveGarbage(colors: Color[]): void {
    if (colors.length === 0 || this.isOver) return;
    this.garbageQueue.push([...colors]);
  }

  drainEvents(): GameEvent[] {
    const e = this.events;
    this.events = [];
    return e;
  }

  step(dt: number, input: StepInput = {}): void {
    switch (this.phase) {
      case 'falling': return this.stepFalling(dt, input);
      case 'clearing': return this.stepClearing(dt);
      case 'settling': return this.stepSettling(dt, input);
      case 'garbage': return this.stepGarbage(dt, input);
    }
  }

  // --- Phases ---

  private stepFalling(dt: number, input: StepInput): void {
    let c = this.active!;
    const board = this.board;

    if (input.rotateCW || input.rotateCCW) {
      const r = tryRotate(board, c, !!input.rotateCW);
      if (r) { c = r; this.emit({ type: 'rotate' }); }
    }
    if (input.left !== input.right) {
      const dir = input.left ? 'left' : 'right';
      const m = tryMove(board, c, 0, dir === 'left' ? -1 : 1);
      if (m) { c = m; this.emit({ type: 'move' }); }
      this.pushing = m ? null : dir;
    } else if (this.pushing && (this.pushing === 'left' ? input.holdLeft : input.holdRight)) {
      // Pushing against something while holding: retry every step (like the original), so the
      // capsule slips into a gap the moment it lines up, even when falling fast.
      const m = tryMove(board, c, 0, this.pushing === 'left' ? -1 : 1);
      if (m) { c = m; this.emit({ type: 'move' }); this.pushing = null; }
    } else {
      this.pushing = null;
    }

    // Just spawned: it hangs at the top for a moment (you can already rotate and move it).
    // Soft drop skips the wait.
    if (this.spawnHold > 0) {
      if (input.softDrop) this.spawnHold = 0;
      else {
        this.spawnHold -= dt;
        this.active = c;
        return;
      }
    }

    const grounded = !tryMove(board, c, 1, 0);
    if (grounded) {
      this.fallTimer = 0;
      this.lockTimer += dt;
      this.active = c;
      if (input.softDrop || this.lockTimer >= LOCK_DELAY_MS) this.lock();
      return;
    }

    this.lockTimer = 0;
    this.fallTimer += dt * (input.softDrop ? SOFT_DROP_MULTIPLIER : 1);
    const interval = this.fallIntervalMs();
    if (this.fallTimer >= interval) {
      this.fallTimer -= interval;
      c = tryMove(board, c, 1, 0)!;
      if (!tryMove(board, c, 1, 0)) this.fallTimer = 0;
    }
    this.active = c;
  }

  private stepClearing(dt: number): void {
    this.phaseTimer += dt;
    this.clearProgress = Math.min(1, this.phaseTimer / CLEAR_ANIMATION_MS);
    if (this.phaseTimer < CLEAR_ANIMATION_MS) return;
    this.board.clear(this.clearingCells);
    this.clearingCells = [];
    if (this.board.germCount() === 0) return this.finish('won');
    this.enter('settling');
  }

  /** Loose halves falling after a clear. With Fast garbage on, holding Down speeds this up too. */
  private stepSettling(dt: number, input: StepInput): void {
    const fast = this.fastGarbage && (input.downHeld ?? input.softDrop);
    this.phaseTimer += dt * (fast ? FAST_GARBAGE_MULTIPLIER : 1);
    while (this.phaseTimer >= GRAVITY_STEP_MS) {
      this.phaseTimer -= GRAVITY_STEP_MS;
      if (!this.board.gravityStep()) return this.resolve();
    }
  }

  private stepGarbage(dt: number, input: StepInput): void {
    const fast = this.fastGarbage && (input.downHeld ?? input.softDrop);
    this.phaseTimer += dt * (fast ? FAST_GARBAGE_MULTIPLIER : 1);
    while (this.phaseTimer >= GARBAGE_FALL_STEP_MS) {
      this.phaseTimer -= GARBAGE_FALL_STEP_MS;
      if (!this.board.gravityStep()) {
        this.emit({ type: 'garbageLanded' });
        return this.resolve();
      }
    }
  }

  // --- Transitions ---

  /** `hold`: hang at the top for ENTRY_DELAY_MS before gravity starts (every capsule but the first). */
  private spawn(hold = false): void {
    const capsule: Capsule = {
      row: 0,
      col: Math.floor(BOARD_COLS / 2) - 1,
      orientation: 0,
      colors: this.pieces.colorsAt(this.pieceIndex),
    };
    if (!fits(this.board, capsule)) {
      this.active = null;
      return this.finish('lost');
    }
    this.active = capsule;
    this.fallTimer = 0;
    this.lockTimer = 0;
    this.spawnHold = hold ? ENTRY_DELAY_MS : 0;
    this.pushing = null;
    this.phase = 'falling';
    this.emit({ type: 'spawn' });
  }

  private lock(): void {
    const [a, b] = capsuleHalves(this.active!);
    this.active = null;
    const intervalBefore = this.fallIntervalMs();
    this.pieceIndex++;
    this.emit({ type: 'lock', cells: [a.pos, b.pos] });
    if (this.fallIntervalMs() < intervalBefore) this.emit({ type: 'speedUp', step: this.speedStep });
    const above = [a, b].filter(h => h.pos.row < 0);
    if (above.length === 2) return this.finish('lost');
    if (above.length === 1) {
      // Half sticks up into the neck: the lower half goes in on its own and may clear;
      // the top half waits to drop in (see overflow).
      const inside = above[0] === a ? b : a;
      this.board.set(inside.pos.row, inside.pos.col, { kind: 'pill', color: inside.color, link: 'none' });
      this.overflow = { col: above[0].pos.col, color: above[0].color };
    } else {
      this.board.placeCapsule(a.pos, a.color, b.pos, b.color);
    }
    this.chainStep = 0;
    this.chainLineColors = [];
    this.resolvingGarbage = false;
    this.resolve();
  }

  /** Board is at rest: clear matches if any, otherwise finish this capsule's turn. */
  private resolve(): void {
    const matches = this.board.findMatches();
    if (matches.length > 0) {
      this.chainStep++;
      if (!this.resolvingGarbage) {
        if (this.chainStep === 1) this.chainFirstColors = [...new Set(matches.map(m => m.color))];
        this.chainLineColors.push(...matches.map(m => m.color));
      }
      const seen = new Set<number>();
      const cells: Pos[] = [];
      for (const m of matches) {
        for (const p of m.cells) {
          const key = p.row * BOARD_COLS + p.col;
          if (!seen.has(key)) { seen.add(key); cells.push(p); }
        }
      }
      this.clearingCells = cells;
      this.clearProgress = 0;
      const germs = cells.filter(p => this.board.get(p.row, p.col)?.kind === 'germ').length;
      this.emit({ type: 'clear', chain: this.chainStep, lines: matches.length, cells, germs });
      return this.enter('clearing');
    }

    // A half left in the neck drops in now if the clears made room, and can keep the chain going.
    if (this.overflow) {
      const { col, color } = this.overflow;
      this.overflow = null;
      if (this.board.get(0, col)) return this.finish('lost');
      this.board.set(0, col, { kind: 'pill', color, link: 'none' });
      return this.enter('settling');
    }

    if (!this.resolvingGarbage) {
      const out = garbageForChain(this.chainLineColors);
      if (out.length > 0) this.emit({ type: 'garbageOut', colors: out, firstColors: this.chainFirstColors });
      this.chainLineColors = [];
    }

    const attack = this.garbageQueue.shift();
    if (attack) {
      this.dropGarbage(attack);
      return;
    }
    this.spawn(true);
  }

  private dropGarbage(colors: Color[]): void {
    const cols = pickGarbageColumns(this.board, colors.length, this.garbageRng);
    cols.forEach((col, i) => this.board.set(0, col, { kind: 'pill', color: colors[i], link: 'none' }));
    this.resolvingGarbage = true;
    this.chainStep = 0;
    this.emit({ type: 'garbageIn', count: cols.length });
    this.enter('garbage');
  }

  private enter(phase: Phase): void {
    this.phase = phase;
    this.phaseTimer = 0;
  }

  private finish(result: 'won' | 'lost'): void {
    this.phase = result;
    this.garbageQueue.length = 0;
    this.emit({ type: result });
  }

  private emit(e: GameEvent): void {
    this.events.push(e);
  }
}
