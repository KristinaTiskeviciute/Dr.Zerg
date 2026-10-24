import { capsuleHalves } from '../core/capsule';
import { Game } from '../core/game';
import { Link } from '../core/types';
import { BoardView } from './draw';

/** Adapt a live Game to what the renderer draws. */
export function gameView(game: Game): BoardView {
  const active: BoardView['active'] = [];
  if (game.active && game.phase === 'falling') {
    const [a, b] = capsuleHalves(game.active);
    const dr = b.pos.row - a.pos.row;
    const dc = b.pos.col - a.pos.col;
    const aToB: Link = dc === 1 ? 'right' : dc === -1 ? 'left' : dr === -1 ? 'up' : 'down';
    const bToA: Link = { right: 'left', left: 'right', up: 'down', down: 'up', none: 'none' }[aToB] as Link;
    active.push({ pos: a.pos, color: a.color, link: aToB }, { pos: b.pos, color: b.color, link: bToA });
  }
  return {
    cols: game.board.cols,
    rows: game.board.rows,
    cells: game.board.cells,
    active,
    next: game.isOver ? null : game.nextColors,
    clearing: game.clearingCells,
    clearProgress: game.clearProgress,
  };
}
