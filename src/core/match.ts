import { ROUNDS_TO_WIN, Speed } from '../config';
import { Board } from './board';
import { Game, GameEvent, StepInput } from './game';
import { Rng } from './rng';
import { garbageTargets } from './targeting';
import { Color } from './types';

export interface PlayerSetup {
  level: number;
  speed: Speed;
}

export interface MatchOptions {
  /** 2–4 players, in seating order (garbage targeting counts "to the right" along this order). */
  players: PlayerSetup[];
  seed: number;
  fastGarbage: boolean;
  /** Outbreak mode: every chain's garbage goes to all other players still in. */
  outbreak?: boolean;
  roundsToWin?: number;
  /** Tests: set up each player's board instead of placing germs. */
  setupBoard?: (board: Board, player: number) => void;
}

export type MatchState = 'playing' | 'roundOver' | 'matchOver';

/** Garbage sent this step: from whom, to whom, which pieces. */
export interface Delivery {
  from: number;
  to: number;
  colors: Color[];
}

/**
 * A versus match for 2–4 players. Every board shares each round's seed (same germs at the
 * same level, same capsules). Garbage goes to the other player with 2; with more, the color
 * of the chain's first clear picks the target. Topping out knocks you out of the round;
 * clearing your bottle, or being the last one standing, wins it. First to ROUNDS_TO_WIN.
 */
export class Match {
  games!: Game[];
  wins: number[];
  round = 0;
  state: MatchState = 'playing';
  /** Winner of the round that just ended; null for a draw. */
  roundWinner: number | null = null;

  private readonly seeds: Rng;
  private readonly roundsToWin: number;

  constructor(private readonly opts: MatchOptions) {
    if (opts.players.length < 2 || opts.players.length > 4) throw new Error('a match needs 2–4 players');
    this.seeds = new Rng(opts.seed);
    this.roundsToWin = opts.roundsToWin ?? ROUNDS_TO_WIN;
    this.wins = opts.players.map(() => 0);
    this.startRound();
  }

  get playerCount(): number {
    return this.games.length;
  }

  get matchWinner(): number | null {
    const i = this.wins.findIndex(w => w >= this.roundsToWin);
    return i >= 0 ? i : null;
  }

  /** Still in this round (hasn't topped out). */
  isAlive(i: number): boolean {
    return this.games[i].phase !== 'lost';
  }

  /** Who garbage from `from` goes to, given the colors of the chain's first clear. */
  targetsFor(from: number, firstColors: Color[]): number[] {
    return garbageTargets(from, this.games.map((_, i) => this.isAlive(i)), firstColors, this.opts.outbreak);
  }

  /** Advance every board one step. Returns each board's events and the garbage sent. */
  step(dt: number, inputs: StepInput[]): GameEvent[][] {
    this.deliveries = [];
    if (this.state !== 'playing') return this.games.map(() => []);
    this.games.forEach((g, i) => g.step(dt, inputs[i] ?? {}));
    const events = this.games.map(g => g.drainEvents());

    events.forEach((list, from) => {
      for (const e of list) {
        if (e.type !== 'garbageOut') continue;
        for (const to of this.targetsFor(from, e.firstColors)) {
          this.games[to].receiveGarbage(e.colors);
          this.deliveries.push({ from, to, colors: e.colors });
        }
      }
    });

    this.decideRound();
    return events;
  }

  /** Garbage sent during the last step (for warnings and effects). */
  deliveries: Delivery[] = [];

  nextRound(): void {
    if (this.state === 'roundOver') this.startRound();
  }

  private decideRound(): void {
    const cleared = this.games.flatMap((g, i) => (g.phase === 'won' ? [i] : []));
    const alive = this.games.flatMap((g, i) => (g.phase !== 'lost' ? [i] : []));
    let over = false;
    if (cleared.length > 0) {
      // Clearing your bottle wins; two clearing on the same step is a draw.
      this.roundWinner = cleared.length === 1 ? cleared[0] : null;
      over = true;
    } else if (alive.length <= 1) {
      // Last one standing wins; everyone out on the same step is a draw.
      this.roundWinner = alive.length === 1 ? alive[0] : null;
      over = true;
    }
    if (!over) return;
    if (this.roundWinner !== null) this.wins[this.roundWinner]++;
    this.state = this.matchWinner === null ? 'roundOver' : 'matchOver';
  }

  private startRound(): void {
    const seed = this.seeds.int(2 ** 32);
    this.round++;
    this.roundWinner = null;
    this.state = 'playing';
    this.games = this.opts.players.map((setup, i) => new Game({
      ...setup,
      seed,
      fastGarbage: this.opts.fastGarbage,
      playerSalt: `p${i}`,
      setupBoard: this.opts.setupBoard ? b => this.opts.setupBoard!(b, i) : undefined,
    }));
  }
}
