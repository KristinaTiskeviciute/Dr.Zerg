import { BOARD_COLS, BOARD_ROWS } from '../config';
import { Game } from '../core/game';
import { Cell, Color, Link, Pos } from '../core/types';
import { BoardView } from '../render/draw';
import { activeHalves } from '../render/view';
import { BoardSnapshot } from './protocol';

// One character per cell: '.' empty, 'a'–'c' germ (red/yellow/blue),
// 'd'–'r' capsule half: 'd' + color * 5 + link (none, left, right, up, down).
const LINKS: readonly Link[] = ['none', 'left', 'right', 'up', 'down'];
const A = 'a'.charCodeAt(0);
const D = 'd'.charCodeAt(0);

function encodeCell(cell: Cell | null): string {
  if (!cell) return '.';
  if (cell.kind === 'germ') return String.fromCharCode(A + cell.color);
  return String.fromCharCode(D + cell.color * 5 + LINKS.indexOf(cell.link));
}

function decodeCell(ch: string): Cell | null {
  if (ch === '.') return null;
  const code = ch.charCodeAt(0);
  if (code < D) return { kind: 'germ', color: (code - A) as Color };
  const i = code - D;
  return { kind: 'pill', color: Math.floor(i / 5) as Color, link: LINKS[i % 5] };
}

/** Your board as a small message for the other player. */
export function encodeSnapshot(game: Game): BoardSnapshot {
  const a = game.active && game.phase === 'falling' ? game.active : null;
  return {
    c: game.board.cells.map(encodeCell).join(''),
    a: a ? [a.row, a.col, a.orientation, a.colors[0], a.colors[1]] : null,
    n: game.isOver ? null : [game.nextColors[0], game.nextColors[1]],
    k: game.clearingCells.map(p => p.row * BOARD_COLS + p.col),
    p: Math.round(game.clearProgress * 100) / 100,
    q: game.queuedGarbage.join(''),
    g: game.germsLeft,
  };
}

/** The other player's board, ready to draw. */
export function snapshotView(s: BoardSnapshot, incomingFresh = false): BoardView {
  const toPos = (i: number): Pos => ({ row: Math.floor(i / BOARD_COLS), col: i % BOARD_COLS });
  return {
    cols: BOARD_COLS,
    rows: BOARD_ROWS,
    cells: [...s.c].map(decodeCell),
    active: s.a
      ? activeHalves({ row: s.a[0], col: s.a[1], orientation: s.a[2] as 0 | 1 | 2 | 3, colors: [s.a[3] as Color, s.a[4] as Color] })
      : [],
    next: s.n ? [s.n[0] as Color, s.n[1] as Color] : null,
    clearing: s.k.map(toPos),
    clearProgress: s.p,
    incoming: { colors: [...s.q].map(ch => Number(ch) as Color), fresh: incomingFresh },
  };
}
