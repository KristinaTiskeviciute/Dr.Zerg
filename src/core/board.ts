import { NECK_COLS } from '../config';
import { Cell, Color, Link, Pos } from './types';

export interface Match {
  color: Color;
  cells: Pos[];
}

const OPPOSITE: Record<Link, Link> = {
  none: 'none',
  left: 'right',
  right: 'left',
  up: 'down',
  down: 'up',
};

export function linkOffset(link: Link): Pos {
  switch (link) {
    case 'left': return { row: 0, col: -1 };
    case 'right': return { row: 0, col: 1 };
    case 'up': return { row: -1, col: 0 };
    case 'down': return { row: 1, col: 0 };
    default: return { row: 0, col: 0 };
  }
}

/** The bottle grid. Row 0 is the top. Rows above 0 count as empty and in-bounds for falling pieces. */
export class Board {
  readonly cells: (Cell | null)[];

  constructor(readonly cols: number, readonly rows: number) {
    this.cells = new Array(cols * rows).fill(null);
  }

  inside(row: number, col: number): boolean {
    return row >= 0 && row < this.rows && col >= 0 && col < this.cols;
  }

  get(row: number, col: number): Cell | null {
    if (!this.inside(row, col)) return null;
    return this.cells[row * this.cols + col];
  }

  set(row: number, col: number, cell: Cell | null): void {
    if (!this.inside(row, col)) throw new Error(`set out of bounds: ${row},${col}`);
    this.cells[row * this.cols + col] = cell;
  }

  /** True if a falling piece may occupy this cell (empty, or above the bottle). */
  isFree(row: number, col: number): boolean {
    if (col < 0 || col >= this.cols || row >= this.rows) return false;
    if (row < 0) return row === -1 && this.inNeck(col); // the one row above the bottle, under the neck only
    return this.get(row, col) === null;
  }

  /** Under the neck (the columns where a half can stick up above the top row). */
  inNeck(col: number): boolean {
    const first = (this.cols - NECK_COLS) / 2;
    return col >= first && col < first + NECK_COLS;
  }

  germCount(): number {
    let n = 0;
    for (const c of this.cells) if (c?.kind === 'germ') n++;
    return n;
  }

  /** Every horizontal or vertical run of minRun+ same-colored cells. Each run is one match ("line"). */
  findMatches(minRun = 4): Match[] {
    const matches: Match[] = [];
    const scan = (lineCount: number, lineLen: number, at: (line: number, i: number) => Pos) => {
      for (let line = 0; line < lineCount; line++) {
        let i = 0;
        while (i < lineLen) {
          const p = at(line, i);
          const start = this.get(p.row, p.col);
          if (!start) { i++; continue; }
          let j = i + 1;
          while (j < lineLen) {
            const q = at(line, j);
            if (this.get(q.row, q.col)?.color !== start.color) break;
            j++;
          }
          if (j - i >= minRun) {
            const cells: Pos[] = [];
            for (let k = i; k < j; k++) cells.push(at(line, k));
            matches.push({ color: start.color, cells });
          }
          i = j;
        }
      }
    };
    scan(this.rows, this.cols, (row, col) => ({ row, col }));
    scan(this.cols, this.rows, (col, row) => ({ row, col }));
    return matches;
  }

  /** Remove cells; any capsule half whose partner was removed becomes a single. */
  clear(positions: Pos[]): void {
    for (const p of positions) {
      const cell = this.get(p.row, p.col);
      if (!cell) continue;
      if (cell.kind === 'pill' && cell.link !== 'none') {
        const o = linkOffset(cell.link);
        const partner = this.get(p.row + o.row, p.col + o.col);
        if (partner?.kind === 'pill') partner.link = 'none';
      }
      this.set(p.row, p.col, null);
    }
  }

  /**
   * Move every unsupported capsule half down one row. Germs never fall.
   * Joined halves fall together. Returns true if anything moved.
   */
  gravityStep(): boolean {
    let moved = false;
    for (let row = this.rows - 2; row >= 0; row--) {
      for (let col = 0; col < this.cols; col++) {
        const cell = this.get(row, col);
        if (cell?.kind !== 'pill') continue;
        switch (cell.link) {
          case 'none':
            if (this.get(row + 1, col) === null) {
              this.move(row, col, row + 1, col);
              moved = true;
            }
            break;
          case 'up':
            // Bottom half of a vertical pair: the pair falls if the cell below is empty.
            if (this.get(row + 1, col) === null) {
              this.move(row, col, row + 1, col);
              this.move(row - 1, col, row, col);
              moved = true;
            }
            break;
          case 'right':
            // Left half of a horizontal pair: both cells below must be empty.
            if (this.get(row + 1, col) === null && this.get(row + 1, col + 1) === null) {
              this.move(row, col, row + 1, col);
              this.move(row, col + 1, row + 1, col + 1);
              moved = true;
            }
            col++; // the right half was handled with its partner
            break;
          // 'down' (top of a vertical pair) moves with its bottom half; 'left' is handled via 'right'.
        }
      }
    }
    return moved;
  }

  /** Place a two-cell capsule at the given positions, linking the halves. */
  placeCapsule(a: Pos, aColor: Color, b: Pos, bColor: Color): void {
    const linkAtoB = linkBetween(a, b);
    this.set(a.row, a.col, { kind: 'pill', color: aColor, link: linkAtoB });
    this.set(b.row, b.col, { kind: 'pill', color: bColor, link: OPPOSITE[linkAtoB] });
  }

  clone(): Board {
    const b = new Board(this.cols, this.rows);
    for (let i = 0; i < this.cells.length; i++) {
      const c = this.cells[i];
      b.cells[i] = c ? { ...c } : null;
    }
    return b;
  }

  private move(fromRow: number, fromCol: number, toRow: number, toCol: number): void {
    const cell = this.get(fromRow, fromCol);
    this.set(toRow, toCol, cell);
    this.set(fromRow, fromCol, null);
  }
}

function linkBetween(a: Pos, b: Pos): Link {
  if (b.col === a.col + 1 && b.row === a.row) return 'right';
  if (b.col === a.col - 1 && b.row === a.row) return 'left';
  if (b.row === a.row - 1 && b.col === a.col) return 'up';
  if (b.row === a.row + 1 && b.col === a.col) return 'down';
  throw new Error('capsule halves are not adjacent');
}
