import { Capsule, capsuleHalves } from '../core/capsule';
import { Game } from '../core/game';
import { Link } from '../core/types';
import { BoardView } from './draw';
import { BoardEffects } from './effects';

const OPPOSITE: Record<Link, Link> = { right: 'left', left: 'right', up: 'down', down: 'up', none: 'none' };

/** A falling capsule's two halves, with the links that make them draw as one joined pill. */
export function activeHalves(c: Capsule): BoardView['active'] {
  const [a, b] = capsuleHalves(c);
  const dr = b.pos.row - a.pos.row;
  const dc = b.pos.col - a.pos.col;
  const aToB: Link = dc === 1 ? 'right' : dc === -1 ? 'left' : dr === -1 ? 'up' : 'down';
  return [
    { pos: a.pos, color: a.color, link: aToB },
    { pos: b.pos, color: b.color, link: OPPOSITE[aToB] },
  ];
}

/** Adapt a live Game (plus its cosmetic effects) to what the renderer draws. */
export function gameView(game: Game, fx?: BoardEffects): BoardView {
  return {
    cols: game.board.cols,
    rows: game.board.rows,
    cells: game.board.cells,
    active: game.active && game.phase === 'falling' ? activeHalves(game.active) : [],
    next: game.isOver ? null : game.nextColors,
    clearing: game.clearingCells,
    clearProgress: game.clearProgress,
    flashes: fx?.flashList,
    incoming: { colors: game.queuedGarbage, fresh: fx?.incomingFresh ?? false },
  };
}
