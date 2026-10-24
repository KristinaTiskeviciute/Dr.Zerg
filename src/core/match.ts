import { ROUNDS_TO_WIN, Speed } from '../config';
import { Board } from './board';
import { Game, GameEvent, StepInput } from './game';
import { Rng } from './rng';

export interface PlayerSetup {
  level: number;
  speed: Speed;
}

export interface MatchOptions {
  players: [PlayerSetup, PlayerSetup];
  seed: number;
  fastGarbage: boolean;
  roundsToWin?: number;
  /** Tests: set up each player's board instead of placing germs. */
  setupBoard?: (board: Board, player: 0 | 1) => void;
}

export type MatchState = 'playing' | 'roundOver' | 'matchOver';

/**
 * A two-player versus match: both boards share each round's seed (same germs at
 * the same level, same capsules), garbage goes to the other board, best of 3.
 * Works the same whether the opponent is the CPU or (later) a remote player's relay.
 */
export class Match {
  games!: [Game, Game];
  wins: [number, number] = [0, 0];
  round = 0;
  state: MatchState = 'playing';
  /** Winner of the round that just ended; null for a draw. */
  roundWinner: 0 | 1 | null = null;

  private readonly seeds: Rng;
  private readonly roundsToWin: number;

  constructor(private readonly opts: MatchOptions) {
    this.seeds = new Rng(opts.seed);
    this.roundsToWin = opts.roundsToWin ?? ROUNDS_TO_WIN;
    this.startRound();
  }

  get matchWinner(): 0 | 1 | null {
    if (this.wins[0] >= this.roundsToWin) return 0;
    if (this.wins[1] >= this.roundsToWin) return 1;
    return null;
  }

  /** Advance both boards one step. Returns each board's events. */
  step(dt: number, inputs: [StepInput, StepInput]): [GameEvent[], GameEvent[]] {
    if (this.state !== 'playing') return [[], []];
    this.games[0].step(dt, inputs[0]);
    this.games[1].step(dt, inputs[1]);
    const events: [GameEvent[], GameEvent[]] = [this.games[0].drainEvents(), this.games[1].drainEvents()];

    events.forEach((list, i) => {
      for (const e of list) if (e.type === 'garbageOut') this.games[1 - i].receiveGarbage(e.colors);
    });

    const claims = new Set<0 | 1>();
    this.games.forEach((g, i) => {
      if (g.phase === 'won') claims.add(i as 0 | 1);
      if (g.phase === 'lost') claims.add((1 - i) as 0 | 1);
    });
    if (claims.size > 0) {
      // Both sides finishing on the same step in each other's favor is a draw.
      this.roundWinner = claims.size === 1 ? [...claims][0] : null;
      if (this.roundWinner !== null) this.wins[this.roundWinner]++;
      this.state = this.matchWinner === null ? 'roundOver' : 'matchOver';
    }
    return events;
  }

  nextRound(): void {
    if (this.state === 'roundOver') this.startRound();
  }

  private startRound(): void {
    const seed = this.seeds.int(2 ** 32);
    this.round++;
    this.roundWinner = null;
    this.state = 'playing';
    this.games = [0, 1].map(i => new Game({
      ...this.opts.players[i],
      seed,
      fastGarbage: this.opts.fastGarbage,
      playerSalt: `p${i}`,
      setupBoard: this.opts.setupBoard ? b => this.opts.setupBoard!(b, i as 0 | 1) : undefined,
    })) as [Game, Game];
  }
}
