import { CELL_PX, GERM_WIGGLE_MS, NECK_COLS } from '../config';
import { Cell, Color, Link, Pos } from '../core/types';
import { BOTTLE, INK, SHADES } from './palette';
import { germDefeated, germFrame, Grid, pillGrid, shade } from './sprites';

/**
 * Everything is drawn in "logical" pixels (CELL_PX = 16 per cell) on a small canvas,
 * which the page scales up with pixelated rendering. Sprites can be swapped for PNG
 * sprite sheets later by replacing drawCapsuleHalf / drawGerm.
 */

/** Everything needed to draw one bottle. Works for your own game and (later) an opponent snapshot. */
export interface BoardView {
  cols: number;
  rows: number;
  cells: readonly (Cell | null)[];
  /** Falling capsule halves, drawn on top of the grid. */
  active: { pos: Pos; color: Color; link: Link }[];
  next: readonly [Color, Color] | null;
  clearing: readonly Pos[];
  clearProgress: number;
  /** Cells to flash white (just-locked capsule), with strength 0–1. */
  flashes?: { pos: Pos; alpha: number }[];
  /** Garbage queued to drop after the current capsule locks, and whether it just arrived (blink). */
  incoming?: { colors: readonly Color[]; fresh: boolean };
}

const FRAME = 4;
const NECK_ROWS = 1; // one row: room to rotate at the top, and keeps the preview close to the spawn
/** How far down a board's canvas the bottle's shoulders are (above them: the preview and the neck), in sprite pixels. */
export const BOTTLE_SHOULDER_PX = (NECK_ROWS + 1) * CELL_PX;

/** Pixel size of the full drawing (bottle + neck + preview) for a board. */
export function boardPixelSize(cols: number, rows: number): { width: number; height: number } {
  return {
    width: cols * CELL_PX + FRAME * 2,
    height: (rows + NECK_ROWS + 1) * CELL_PX + FRAME * 2,
  };
}

export function drawBoard(ctx: CanvasRenderingContext2D, view: BoardView, x: number, y: number, timeMs: number): void {
  const s = CELL_PX;
  const gridX = x + FRAME;
  const gridY = y + FRAME + (NECK_ROWS + 1) * s;
  drawBottle(ctx, gridX, gridY, view.cols, view.rows);

  const previewX = gridX + (view.cols / 2 - 1) * s;
  const previewY = gridY - (NECK_ROWS + 1) * s + 1;
  if (view.next) {
    drawCapsuleHalf(ctx, previewX, previewY, view.next[0], 'right');
    drawCapsuleHalf(ctx, previewX + s, previewY, view.next[1], 'left');
  }

  if (view.incoming && view.incoming.colors.length > 0) {
    drawIncoming(ctx, gridX, gridY - FRAME - 1, view.incoming.colors, view.incoming.fresh, timeMs);
  }

  const frame = Math.floor(timeMs / GERM_WIGGLE_MS) % 2;
  const clearingKeys = new Set(view.clearing.map(p => p.row * view.cols + p.col));

  for (let row = 0; row < view.rows; row++) {
    for (let col = 0; col < view.cols; col++) {
      const cell = view.cells[row * view.cols + col];
      if (!cell) continue;
      const px = gridX + col * s;
      const py = gridY + row * s;
      if (clearingKeys.has(row * view.cols + col)) {
        drawPop(ctx, px, py, cell, view.clearProgress, frame);
      } else if (cell.kind === 'germ') {
        // Neighbouring germs wiggle out of step so the bottle feels alive.
        drawGerm(ctx, px, py, cell.color, (frame + row + col) % 2);
      } else {
        drawCapsuleHalf(ctx, px, py, cell.color, cell.link);
      }
    }
  }

  // Halves above row 0 (just rotated at the top) show up in the neck.
  for (const h of view.active) {
    drawCapsuleHalf(ctx, gridX + h.pos.col * s, gridY + h.pos.row * s, h.color, h.link);
  }

  for (const f of view.flashes ?? []) {
    ctx.globalAlpha = f.alpha * 0.8;
    ctx.fillStyle = INK.white;
    ctx.fillRect(gridX + f.pos.col * s + 1, gridY + f.pos.row * s + 1, s - 2, s - 2);
    ctx.globalAlpha = 1;
  }
}

/**
 * Incoming garbage: little single-half pills above the bottle's left shoulder, 3 per row
 * (up to 9), bottom row first. (left, bottom) is where the stack starts. Blinks while fresh.
 */
function drawIncoming(
  ctx: CanvasRenderingContext2D, left: number, bottom: number, colors: readonly Color[], fresh: boolean, timeMs: number,
): void {
  if (fresh && Math.floor(timeMs / 120) % 2 === 1) return;
  const size = 8;
  colors.slice(0, 9).forEach((color, i) => {
    const x = left + 2 + (i % 3) * size;
    const y = bottom - size * (1 + Math.floor(i / 3));
    const img = paint(`pill:${color}:none`, shade(pillGrid('none'), true), colorsFor(color));
    ctx.drawImage(img, x, y, size, size);
  });
}

/** Pixel bottle with a neck. (gx, gy) is the top-left of the playfield grid. */
export function drawBottle(ctx: CanvasRenderingContext2D, gx: number, gy: number, cols: number, rows: number): void {
  const s = CELL_PX;
  const w = cols * s;
  const h = rows * s;
  const neckW = NECK_COLS * s;
  const neckX = gx + (w - neckW) / 2;
  const neckTop = gy - NECK_ROWS * s;

  // Glass with a faint checker dither, one cell per square
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      ctx.fillStyle = (r + c) % 2 ? BOTTLE.glassA : BOTTLE.glassB;
      ctx.fillRect(gx + c * s, gy + r * s, s, s);
    }
  }
  ctx.fillStyle = BOTTLE.glassA;
  ctx.fillRect(neckX, neckTop, neckW, NECK_ROWS * s);

  // Shine stripe down the left side
  ctx.fillStyle = BOTTLE.shine;
  ctx.fillRect(gx + 3, gy + 3, 3, h - 6);
  ctx.fillRect(gx + 8, gy + 3, 1, h - 6);

  // Frame, outside in: 1px dark edge, 2px light glass rim, 1px shade.
  const layers: [offset: number, thickness: number, color: string][] = [
    [FRAME, 1, BOTTLE.frameDark],
    [FRAME - 1, 2, BOTTLE.frame],
    [FRAME - 3, 1, BOTTLE.frameShade],
  ];
  for (const [o, t, color] of layers) {
    ctx.fillStyle = color;
    const top = neckTop - 2;
    ctx.fillRect(gx - o, gy - o, t, h + o * 2); // left side
    ctx.fillRect(gx + w + o - t, gy - o, t, h + o * 2); // right side
    ctx.fillRect(gx - o, gy + h + o - t, w + o * 2, t); // bottom
    ctx.fillRect(gx - o, gy - o, neckX - gx + t, t); // left shoulder
    ctx.fillRect(neckX + neckW + o - t, gy - o, gx + w - neckX - neckW + t, t); // right shoulder
    ctx.fillRect(neckX - o, top, t, gy - o + t - top); // neck left
    ctx.fillRect(neckX + neckW + o - t, top, t, gy - o + t - top); // neck right
  }
}

// --- Sprites (painted once, cached) ---

const spriteCache = new Map<string, HTMLCanvasElement>();

function paint(key: string, grid: Grid, colors: Record<string, string>): HTMLCanvasElement {
  let c = spriteCache.get(key);
  if (c) return c;
  c = document.createElement('canvas');
  c.width = grid[0].length;
  c.height = grid.length;
  const g = c.getContext('2d')!;
  grid.forEach((row, y) => {
    for (let x = 0; x < row.length; x++) {
      const color = colors[row[x]];
      if (!color) continue;
      g.fillStyle = color;
      g.fillRect(x, y, 1, 1);
    }
  });
  spriteCache.set(key, c);
  return c;
}

function colorsFor(color: Color): Record<string, string> {
  const sh = SHADES[color];
  return {
    o: sh.outline, b: sh.base, l: sh.light, d: sh.dark,
    w: INK.glint, W: INK.white, k: INK.pupil, m: sh.outline,
  };
}

/** One capsule half. `link` points at its partner; that side is flat so the halves join. */
export function drawCapsuleHalf(ctx: CanvasRenderingContext2D, px: number, py: number, color: Color, link: Link): void {
  const img = paint(`pill:${color}:${link}`, shade(pillGrid(link), true), colorsFor(color));
  ctx.drawImage(img, Math.round(px), Math.round(py));
}

/** A germ. Each color has its own design (see sprites.ts); `frame` 0/1 is the wiggle. */
export function drawGerm(ctx: CanvasRenderingContext2D, px: number, py: number, color: Color, frame: number): void {
  const img = paint(`germ:${color}:${frame}`, shade(germFrame(color, frame), false), colorsFor(color));
  ctx.drawImage(img, Math.round(px), Math.round(py));
}

const ALL_WHITE: Record<string, string> = Object.fromEntries([...'obldwWkm'].map(ch => [ch, INK.white]));

/**
 * Clear effect. Germs first show a defeated face, blinking white, then burst;
 * capsule halves flash white and burst. The burst is pixel sparks flying outward.
 */
function drawPop(ctx: CanvasRenderingContext2D, px: number, py: number, cell: Cell, t: number, frame: number): void {
  const hold = cell.kind === 'germ' ? 0.45 : 0.25;
  if (t < hold) {
    const blink = Math.floor(t * 16) % 2 === 1;
    const grid = cell.kind === 'germ' ? germDefeated(cell.color) : pillGrid(cell.link);
    const key = `${cell.kind}:${cell.color}:${cell.kind === 'pill' ? cell.link : 'x'}`;
    const img = cell.kind === 'pill' || blink
      ? paint(`white:${key}`, grid, ALL_WHITE)
      : paint(`defeated:${key}`, shade(grid, false), colorsFor(cell.color));
    // A tiny squash as it's hit
    const squash = cell.kind === 'germ' && blink ? 1 : 0;
    ctx.drawImage(img, Math.round(px), Math.round(py) + squash, 16, 16 - squash);
    return;
  }
  const sh = SHADES[cell.color];
  const cx = px + 8;
  const cy = py + 8;
  const u = (t - hold) / (1 - hold);
  const d = Math.round(3 + u * 10);
  const size = u < 0.6 ? 2 : 1;
  const colors = [INK.white, sh.light, sh.base];
  const dirs = [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [-1, 1], [1, -1], [-1, -1]];
  dirs.forEach(([dx, dy], i) => {
    const diag = dx !== 0 && dy !== 0;
    const k = diag ? Math.round(d * 0.75) : d;
    ctx.fillStyle = colors[(i + frame) % colors.length];
    ctx.fillRect(cx + dx * k - 1, cy + dy * k - 1, size, size);
  });
}
