import { BOARD_COLS, CpuSkill, MAX_GARBAGE_PER_ATTACK, MIN_CLEARS_FOR_GARBAGE } from '../config';
import { Board } from './board';
import { Capsule, capsuleHalves, tryMove, tryRotate } from './capsule';
import { Game, StepInput } from './game';
import { Rng } from './rng';
import { Color } from './types';

/** A spot the current capsule can end up in, and the orientation/column to steer it to. */
export interface Placement {
  orientation: Capsule['orientation'];
  col: number;
  final: Capsule;
  score: number;
  /** Garbage pieces locking here would send right away. */
  sends: number;
}

/** How many of the best first moves get a look-ahead with the next capsule. */
const LOOKAHEAD_CANDIDATES = 8;
/** Extra value per garbage piece a move would send (chains / multi-line clears). */
const ATTACK_BONUS = 120;
/** How many of the best moves get checked for leaving a chain set up. */
const CHAIN_CANDIDATES = 40;
/** Value per extra line of a chain that's ready to go (scaled by skill.chainBuilding). Kept below cashing in. */
const CHAIN_SETUP_BONUS = 60;
/** When an attack is overdue, attack and setup values are multiplied by up to 1 + this. */
const URGENCY_BOOST = 4;
/** Capsule pieces this close to the top put the CPU in panic mode: survive first, no chain building. */
const PANIC_ROWS = 6;
const PANIC_HEIGHT_WEIGHT = 5;

function spawnCapsule(colors: readonly [Color, Color]): Capsule {
  return { row: 0, col: Math.floor(BOARD_COLS / 2) - 1, orientation: 0, colors };
}

export type Move = 'left' | 'right' | 'cw' | 'ccw' | 'down';

const stateKey = (c: Capsule) => `${c.row},${c.col},${c.orientation}`;

/** Same cells + colors = same result (e.g. a red-red capsule turned 180°). */
const resultKey = (c: Capsule) => capsuleHalves(c).map(h => `${h.pos.row},${h.pos.col},${h.color}`).sort().join('|');

// Sideways moves and rotations come before 'down', so among equally short paths the
// search prefers lining up high and dropping, and only tucks in late when it has to.
function neighbours(board: Board, c: Capsule): [Move, Capsule | null][] {
  return [
    ['left', tryMove(board, c, 0, -1)],
    ['right', tryMove(board, c, 0, 1)],
    ['cw', tryRotate(board, c, true)],
    ['ccw', tryRotate(board, c, false)],
    ['down', tryMove(board, c, 1, 0)],
  ];
}

/**
 * Breadth-first search over every way the capsule can move (down, sideways and rotating
 * at any height), so tucks and slide-unders are found too. Calls `visit` for each state;
 * stop early by returning true.
 */
function explore(
  board: Board, start: Capsule, visit: (c: Capsule, path: () => Move[]) => boolean | void,
): void {
  const parent = new Map<string, { from: string | null; move: Move | null; cap: Capsule }>();
  parent.set(stateKey(start), { from: null, move: null, cap: start });
  const queue: Capsule[] = [start];
  const pathTo = (key: string) => {
    const moves: Move[] = [];
    for (let p = parent.get(key)!; p.from !== null; p = parent.get(p.from)!) moves.push(p.move!);
    return moves.reverse();
  };
  for (let i = 0; i < queue.length; i++) {
    const c = queue[i];
    const key = stateKey(c);
    if (visit(c, () => pathTo(key))) return;
    for (const [move, next] of neighbours(board, c)) {
      if (!next || parent.has(stateKey(next))) continue;
      parent.set(stateKey(next), { from: key, move, cap: next });
      queue.push(next);
    }
  }
}

/** Every resting spot the capsule can reach from where it is now. */
export function reachablePlacements(board: Board, start: Capsule): Placement[] {
  const out: Placement[] = [];
  const seen = new Set<string>();
  explore(board, start, c => {
    if (tryMove(board, c, 1, 0)) return; // not resting
    const key = resultKey(c);
    if (seen.has(key)) return;
    seen.add(key);
    out.push({ orientation: c.orientation, col: c.col, final: c, score: 0, sends: 0 });
  });
  return out;
}

/** Shortest list of moves from `start` to a resting spot equivalent to `target`, or null if unreachable. */
export function findPath(board: Board, start: Capsule, target: Capsule): Move[] | null {
  const want = resultKey(target);
  let found: Move[] | null = null;
  explore(board, start, (c, path) => {
    if (resultKey(c) === want && !tryMove(board, c, 1, 0)) {
      found = path();
      return true;
    }
  });
  return found;
}

interface Outcome {
  board: Board;
  /** Value of what happened right away: germs cleared, lines, garbage sent, winning. */
  gain: number;
  won: boolean;
  /** Garbage pieces this move sends. */
  sent: number;
}

/** What the CPU cares about right now: attacking (rises the longer it goes without) vs. staying alive. */
export interface Priorities {
  attack: number; // per garbage piece sent
  setup: number; // per extra line of a chain left ready to go
  height: number; // multiplier on the tall-stack penalty (raised in panic mode)
}

const CALM: Priorities = { attack: ATTACK_BONUS, setup: 0, height: 1 };

/** Lock `final` on a copy of the board and play out all clears and chains. Null if it tops out. */
function simulate(board: Board, final: Capsule, prio: Priorities = CALM): Outcome | null {
  const halves = capsuleHalves(final);
  if (halves.some(h => h.pos.row < 0)) return null;
  const b = board.clone();
  b.placeCapsule(halves[0].pos, halves[0].color, halves[1].pos, halves[1].color);
  const germsBefore = b.germCount();
  let lines = 0;
  for (let m = b.findMatches(); m.length > 0; m = b.findMatches()) {
    lines += m.length;
    b.clear(m.flatMap(x => x.cells));
    while (b.gravityStep());
  }
  const won = b.germCount() === 0;
  const sent = lines >= MIN_CLEARS_FOR_GARBAGE ? Math.min(lines, MAX_GARBAGE_PER_ATTACK) : 0;
  const gain = (germsBefore - b.germCount()) * 150 + lines * 20 + sent * prio.attack + (won ? 1e5 : 0);
  return { board: b, gain, won, sent };
}

/** How good is it to lock `final` here (one move, no look-ahead)? Higher is better. */
export function scorePlacement(board: Board, final: Capsule, prio: Priorities = CALM): number {
  const o = simulate(board, final, prio);
  return o ? o.gain + evaluateBoard(o.board, prio.height) : -1e9;
}

/** Static judgement of a board at rest. */
export function evaluateBoard(b: Board, heightWeight = 1): number {
  return germOutlook(b) - heightPenalty(b) * heightWeight - colorBreaks(b) * 8;
}

/**
 * Panic when capsule pieces are piled within PANIC_ROWS of the top. (Germs don't count:
 * at high levels they start near the top by design.)
 */
export function isPanicking(b: Board): boolean {
  for (let row = 0; row < PANIC_ROWS; row++) {
    for (let col = 0; col < b.cols; col++) if (b.get(row, col)?.kind === 'pill') return true;
  }
  return false;
}

/**
 * How promising the board is for the germs that are left: reward same-colored
 * runs through a germ (closer to 4), punish anything piled on top of it,
 * and count loose capsule halves as junk.
 */
function germOutlook(b: Board): number {
  const RUN_BONUS = [0, 0, 25, 60];
  // A germ hanging over empty space can only be reached by building up under it.
  // That matters most at the end, when the last few germs are all that's left.
  const gapWeight = b.germCount() <= 3 ? 12 : 3;
  let s = 0;
  for (let row = 0; row < b.rows; row++) {
    for (let col = 0; col < b.cols; col++) {
      const cell = b.get(row, col);
      if (!cell) continue;
      if (cell.kind === 'pill') { s -= 3; continue; }

      // Vertical run through this germ, then whatever is piled on top of it.
      let top = row;
      while (b.get(top - 1, col)?.color === cell.color) top--;
      let bottom = row;
      while (b.get(bottom + 1, col)?.color === cell.color) bottom++;
      s += RUN_BONUS[Math.min(3, bottom - top + 1)];
      let blockers = 0;
      for (let r = top - 1; r >= 0 && b.get(r, col); r--) blockers++;
      s -= blockers * 15;
      let gap = 0;
      for (let r = bottom + 1; r < b.rows && !b.get(r, col); r++) gap++;
      s -= gap * gapWeight;

      let left = col;
      while (b.get(row, left - 1)?.color === cell.color) left--;
      let right = col;
      while (b.get(row, right + 1)?.color === cell.color) right++;
      s += RUN_BONUS[Math.min(3, right - left + 1)] / 2;
    }
  }
  return s;
}

/** Places in each column where a color sits on a different color (germ-on-germ doesn't count). */
function colorBreaks(b: Board): number {
  let n = 0;
  for (let col = 0; col < b.cols; col++) {
    for (let row = 0; row < b.rows - 1; row++) {
      const a = b.get(row, col);
      const c = b.get(row + 1, col);
      if (a && c && a.color !== c.color && !(a.kind === 'germ' && c.kind === 'germ')) n++;
    }
  }
  return n;
}

/** Tall stacks are risky, and anything near the spawn is deadly. */
function heightPenalty(b: Board): number {
  let p = 0;
  for (let c = 0; c < b.cols; c++) {
    let top = b.rows;
    for (let r = 0; r < b.rows; r++) if (b.get(r, c)) { top = r; break; }
    const h = b.rows - top;
    p += h * h * 0.15;
    if ((c === 3 || c === 4) && top <= 3) p += 2000;
    else if (top <= 1) p += 300;
  }
  return p;
}

/**
 * Is a chain set up? Tries dropping one capsule half of each color onto each column and
 * returns the most lines any single drop would clear (2+ means a chain is ready to go).
 */
export function chainPotential(board: Board): number {
  let best = 0;
  for (let col = 0; col < board.cols; col++) {
    let row = board.rows - 1;
    while (row >= 0 && board.get(row, col)) row--;
    if (row < 2) continue; // too close to the top to count on
    for (const color of [Color.Red, Color.Yellow, Color.Blue]) {
      const b = board.clone();
      b.set(row, col, { kind: 'pill', color, link: 'none' });
      let lines = 0;
      for (let m = b.findMatches(); m.length > 0; m = b.findMatches()) {
        lines += m.length;
        b.clear(m.flatMap(x => x.cells));
        while (b.gravityStep());
      }
      best = Math.max(best, lines);
    }
  }
  return best;
}

/**
 * Pick where to put the current capsule. With `next` known, the best few first
 * moves are re-scored by the best follow-up with the next capsule.
 */
export function choosePlacement(
  board: Board, active: Capsule, rng: Rng, skill: CpuSkill, next?: readonly [Color, Color],
  prio: Priorities = { attack: ATTACK_BONUS, setup: CHAIN_SETUP_BONUS * skill.chainBuilding, height: 1 },
): Placement | null {
  const options = reachablePlacements(board, active).map(p => {
    const o = simulate(board, p.final, prio);
    return { ...p, score: o ? o.gain + evaluateBoard(o.board, prio.height) : -1e9, sends: o?.sent ?? 0 };
  });
  if (options.length === 0) return null;
  options.sort((a, b) => b.score - a.score);

  if (next) {
    for (const p of options.slice(0, LOOKAHEAD_CANDIDATES)) {
      const o = simulate(board, p.final, prio);
      if (!o || o.won) continue;
      let best = -1e9;
      for (const q of reachablePlacements(o.board, spawnCapsule(next))) {
        best = Math.max(best, scorePlacement(o.board, q.final, prio));
      }
      p.score = o.gain + best;
    }
    options.sort((a, b) => b.score - a.score);
  }

  if (prio.setup > 0) {
    for (const p of options.slice(0, CHAIN_CANDIDATES)) {
      const o = simulate(board, p.final, prio);
      if (!o || o.won) continue;
      const lines = chainPotential(o.board);
      if (lines >= 2) p.score += (lines - 1) * prio.setup;
    }
    options.sort((a, b) => b.score - a.score);
  }

  if (rng.next() < skill.mistakeChance) {
    return options[1 + rng.int(Math.min(skill.topChoices, options.length - 1))] ?? options[0];
  }
  return options[0];
}

/**
 * Plays a Game like a person at a keyboard: thinks for a moment, then presses
 * rotate/left/right at its own pace until the capsule is lined up.
 */
export class CpuController {
  private readonly rng: Rng;
  private pieceIndex = -1;
  private target: Capsule | null = null;
  private thinkLeft = 0;
  private actionTimer = 0;
  private giveUp = false;
  /** Path from the capsule state it was planned at (re-planned only when the capsule moves). */
  private path: Move[] | null = null;
  private pathFrom = '';
  /** Time since it last sent garbage; the longer, the harder it goes for chains. */
  private sinceAttack = 0;
  private attackPlanned = false;

  constructor(private readonly skill: CpuSkill, seed: number) {
    this.rng = new Rng(seed);
  }

  /** 0 right after an attack, rising to 1 when it's overdue (skill.attackEveryS). */
  get urgency(): number {
    return Math.min(1, this.sinceAttack / (this.skill.attackEveryS * 1000));
  }

  poll(game: Game, dt: number): StepInput {
    this.sinceAttack += dt;
    if (game.phase === 'garbage') return { softDrop: this.skill.softDrop };
    const c = game.active;
    if (game.phase !== 'falling' || !c) return {};

    if (game.pieceIndex !== this.pieceIndex) {
      if (this.attackPlanned) this.sinceAttack = 0; // the capsule it aimed at a chain has locked
      this.attackPlanned = false;
      this.pieceIndex = game.pieceIndex;
      this.target = null;
      this.giveUp = false;
      // Reaction time varies a little; sometimes (mostly on Easy) it hesitates and lets the capsule fall a while.
      this.thinkLeft = this.skill.thinkMs * (0.6 + 0.8 * this.rng.next());
      if (this.rng.next() < this.skill.hesitateChance) this.thinkLeft += 500 + 1000 * this.rng.next();
      this.actionTimer = 0;
      this.path = null;
      this.pathFrom = '';
    }

    if (!this.target && !this.giveUp) {
      this.thinkLeft -= dt;
      if (this.thinkLeft > 0) return {};
      const next = this.skill.lookahead ? game.nextColors : undefined;
      const boost = 1 + URGENCY_BOOST * this.urgency;
      const prio: Priorities = isPanicking(game.board)
        ? { attack: ATTACK_BONUS, setup: 0, height: PANIC_HEIGHT_WEIGHT }
        : { attack: ATTACK_BONUS * boost, setup: CHAIN_SETUP_BONUS * this.skill.chainBuilding * boost, height: 1 };
      const p = choosePlacement(game.board, c, this.rng, this.skill, next, prio);
      if (p) {
        this.target = p.final;
        this.attackPlanned = p.sends > 0;
      } else this.giveUp = true;
    }
    this.actionTimer -= dt;
    if (this.giveUp || !this.target) return { softDrop: this.skill.softDrop };

    // Re-plan from where the capsule really is (it keeps falling while we press keys).
    if (stateKey(c) !== this.pathFrom) {
      this.path = findPath(game.board, c, this.target);
      this.pathFrom = stateKey(c);
    }
    const path = this.path;
    if (!path) {
      // Fell past the window for that spot: just let it land.
      this.giveUp = true;
      return { softDrop: this.skill.softDrop };
    }
    const nextMove = path.find(m => m !== 'down');
    if (!nextMove) return { softDrop: this.skill.softDrop }; // only falling left
    if (path[0] === 'down') return {}; // wait for gravity to bring it to the right height
    if (this.actionTimer > 0) return {};
    this.actionTimer = this.skill.moveMs;
    switch (nextMove) {
      case 'left': return { left: true };
      case 'right': return { right: true };
      case 'cw': return { rotateCW: true };
      case 'ccw': return { rotateCCW: true };
    }
  }
}
