import { CELL_PX, GERM_WIGGLE_MS } from '../config';
import { Cell, Color, Link, Pos } from '../core/types';
import { BOTTLE, SHADES } from './palette';

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
}

const FRAME = 6;
const NECK_ROWS = 2;

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

  if (view.next) {
    const nx = gridX + (view.cols / 2 - 1) * s;
    const ny = gridY - (NECK_ROWS + 1) * s + s * 0.35;
    drawCapsuleHalf(ctx, nx, ny, s, view.next[0], 'right');
    drawCapsuleHalf(ctx, nx + s, ny, s, view.next[1], 'left');
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
        drawPop(ctx, px, py, s, cell.color, view.clearProgress);
      } else if (cell.kind === 'germ') {
        drawGerm(ctx, px, py, s, cell.color, (frame + row + col) % 2);
      } else {
        drawCapsuleHalf(ctx, px, py, s, cell.color, cell.link);
      }
    }
  }

  // Halves above row 0 (just rotated at the top) show up in the neck.
  for (const h of view.active) {
    drawCapsuleHalf(ctx, gridX + h.pos.col * s, gridY + h.pos.row * s, s, h.color, h.link);
  }
}

/** Bottle frame with a neck at the top. (gx, gy) is the top-left of the playfield grid. */
export function drawBottle(ctx: CanvasRenderingContext2D, gx: number, gy: number, cols: number, rows: number): void {
  const s = CELL_PX;
  const w = cols * s;
  const h = rows * s;
  const neckW = 4 * s;
  const neckX = gx + (w - neckW) / 2;
  const neckTop = gy - NECK_ROWS * s;

  // Glass
  ctx.fillStyle = BOTTLE.glass;
  ctx.fillRect(gx, gy, w, h);
  ctx.fillRect(neckX, neckTop, neckW, NECK_ROWS * s);

  // Subtle grid
  ctx.strokeStyle = BOTTLE.grid;
  ctx.lineWidth = 1;
  for (let c = 1; c < cols; c++) line(ctx, gx + c * s + 0.5, gy, gx + c * s + 0.5, gy + h);
  for (let r = 1; r < rows; r++) line(ctx, gx, gy + r * s + 0.5, gx + w, gy + r * s + 0.5);

  // Frame outline: body + shoulders + neck
  const f = FRAME / 2;
  ctx.lineWidth = FRAME;
  ctx.lineJoin = 'round';
  ctx.strokeStyle = BOTTLE.frame;
  ctx.beginPath();
  ctx.moveTo(neckX - f, neckTop - f * 2);
  ctx.lineTo(neckX - f, gy - f);
  ctx.lineTo(gx - f, gy - f);
  ctx.lineTo(gx - f, gy + h + f);
  ctx.lineTo(gx + w + f, gy + h + f);
  ctx.lineTo(gx + w + f, gy - f);
  ctx.lineTo(neckX + neckW + f, gy - f);
  ctx.lineTo(neckX + neckW + f, neckTop - f * 2);
  ctx.stroke();

  // Glass shine
  ctx.fillStyle = 'rgba(255,255,255,0.05)';
  ctx.fillRect(gx + 4, gy + 4, 6, h - 8);
}

/** One capsule half. `link` points at its partner; that side is drawn flat so the halves join. */
export function drawCapsuleHalf(
  ctx: CanvasRenderingContext2D, px: number, py: number, s: number, color: Color, link: Link,
): void {
  const shade = SHADES[color];
  const inset = s * 0.08;
  const x = px + inset;
  const y = py + inset;
  const w = s - inset * 2;
  const h = s - inset * 2;
  const r = w / 2;
  // Corner radii: [top-left, top-right, bottom-right, bottom-left]; flatten the side facing the partner.
  const radii = [r, r, r, r];
  const flat = s * 0.06;
  let fx = x, fy = y, fw = w, fh = h;
  switch (link) {
    case 'right': radii[1] = radii[2] = flat; fw += inset; break;
    case 'left': radii[0] = radii[3] = flat; fx -= inset; fw += inset; break;
    case 'up': radii[0] = radii[1] = flat; fy -= inset; fh += inset; break;
    case 'down': radii[2] = radii[3] = flat; fh += inset; break;
  }

  ctx.beginPath();
  ctx.roundRect(fx, fy, fw, fh, radii);
  ctx.fillStyle = shade.base;
  ctx.fill();
  ctx.lineWidth = Math.max(1.5, s * 0.07);
  ctx.strokeStyle = shade.dark;
  ctx.stroke();

  // Highlight
  ctx.beginPath();
  ctx.ellipse(x + w * 0.35, y + h * 0.3, w * 0.16, h * 0.1, -0.5, 0, Math.PI * 2);
  ctx.fillStyle = shade.light;
  ctx.globalAlpha = 0.85;
  ctx.fill();
  ctx.globalAlpha = 1;
}

/**
 * A germ: a wobbly blob with a face. Each color has its own look:
 * red has two horns, yellow an antenna, blue three eyes. `frame` (0/1) is the wiggle.
 */
export function drawGerm(ctx: CanvasRenderingContext2D, px: number, py: number, s: number, color: Color, frame: number): void {
  const shade = SHADES[color];
  const cx = px + s / 2;
  const cy = py + s * 0.55;
  const squash = frame ? 0.04 : -0.02;
  const rx = s * (0.38 + squash);
  const ry = s * (0.32 - squash);

  // Extras behind the body
  ctx.lineWidth = Math.max(1.5, s * 0.07);
  ctx.strokeStyle = shade.dark;
  ctx.fillStyle = shade.base;
  if (color === Color.Red) {
    for (const side of [-1, 1]) {
      ctx.beginPath();
      ctx.moveTo(cx + side * rx * 0.35, cy - ry * 0.7);
      ctx.lineTo(cx + side * rx * (0.75 + frame * 0.1), cy - ry * 1.45);
      ctx.lineTo(cx + side * rx * 0.75, cy - ry * 0.45);
      ctx.closePath();
      ctx.fill();
      ctx.stroke();
    }
  } else if (color === Color.Yellow) {
    const tipX = cx + (frame ? 2 : -2);
    line(ctx, cx, cy - ry * 0.8, tipX, cy - ry * 1.55);
    ctx.beginPath();
    ctx.arc(tipX, cy - ry * 1.55, s * 0.07, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();
  }

  // Body: ellipse with little feet along the bottom
  ctx.beginPath();
  ctx.ellipse(cx, cy, rx, ry, 0, Math.PI, 0);
  const feet = 3;
  for (let i = 0; i < feet; i++) {
    const x0 = cx + rx - (2 * rx * i) / feet;
    const x1 = cx + rx - (2 * rx * (i + 1)) / feet;
    const dip = ry * (frame === i % 2 ? 0.95 : 0.75);
    ctx.quadraticCurveTo((x0 + x1) / 2, cy + dip * 1.4, x1, cy + (i === feet - 1 ? 0 : ry * 0.55));
  }
  ctx.closePath();
  ctx.fillStyle = shade.base;
  ctx.fill();
  ctx.stroke();

  // Eyes
  const eyes = color === Color.Blue ? [-0.45, 0, 0.45] : [-0.32, 0.32];
  const eyeR = s * (color === Color.Blue ? 0.075 : 0.095);
  const look = frame ? 1 : -1;
  for (const ex of eyes) {
    const x = cx + ex * rx;
    const y = cy - ry * 0.25;
    ctx.beginPath();
    ctx.arc(x, y, eyeR, 0, Math.PI * 2);
    ctx.fillStyle = '#fff';
    ctx.fill();
    ctx.beginPath();
    ctx.arc(x + look * eyeR * 0.35, y + eyeR * 0.15, eyeR * 0.5, 0, Math.PI * 2);
    ctx.fillStyle = '#111';
    ctx.fill();
  }

  // Mouth: a grin that flips to an "o" on the second frame
  ctx.strokeStyle = shade.dark;
  ctx.lineWidth = Math.max(1.2, s * 0.05);
  ctx.beginPath();
  if (frame) ctx.arc(cx, cy + ry * 0.35, s * 0.05, 0, Math.PI * 2);
  else ctx.arc(cx, cy + ry * 0.15, s * 0.11, 0.15 * Math.PI, 0.85 * Math.PI);
  ctx.stroke();
}

/** Clear effect: the block swells and fades while a ring bursts outward. */
function drawPop(ctx: CanvasRenderingContext2D, px: number, py: number, s: number, color: Color, t: number): void {
  const shade = SHADES[color];
  const cx = px + s / 2;
  const cy = py + s / 2;
  ctx.save();
  ctx.globalAlpha = 1 - t;
  ctx.beginPath();
  ctx.arc(cx, cy, s * (0.35 + 0.2 * t), 0, Math.PI * 2);
  ctx.fillStyle = shade.light;
  ctx.fill();
  ctx.beginPath();
  ctx.arc(cx, cy, s * (0.3 + 0.5 * t), 0, Math.PI * 2);
  ctx.strokeStyle = shade.base;
  ctx.lineWidth = s * 0.12 * (1 - t) + 1;
  ctx.stroke();
  ctx.restore();
}

function line(ctx: CanvasRenderingContext2D, x0: number, y0: number, x1: number, y1: number): void {
  ctx.beginPath();
  ctx.moveTo(x0, y0);
  ctx.lineTo(x1, y1);
  ctx.stroke();
}
