import { BOARD_COLS, BOARD_ROWS } from '../config';
import { BoardView, boardPixelSize, drawBoard } from '../render/draw';
import { BoardEffects } from '../render/effects';

interface OpponentSlot {
  wrap: HTMLElement;
  canvas: HTMLCanvasElement;
  ctx: CanvasRenderingContext2D;
  fx: BoardEffects;
}

/** The opponents' bottles (1–3), each with its name underneath and an "OUT" state. */
export class OpponentBoards {
  private slots: OpponentSlot[] = [];

  constructor(private readonly container: HTMLElement) {}

  get count(): number {
    return this.slots.length;
  }

  setup(labels: string[]): void {
    this.slots = labels.map(text => {
      const wrap = document.createElement('div');
      wrap.className = 'opponent';
      const canvas = document.createElement('canvas');
      const label = document.createElement('span');
      label.className = 'label';
      label.textContent = text;
      wrap.append(canvas, label);
      return { wrap, canvas, ctx: canvas.getContext('2d')!, fx: new BoardEffects() };
    });
    this.container.replaceChildren(...this.slots.map(s => s.wrap));
    this.container.classList.toggle('many', labels.length > 1);
  }

  /** Every opponent's canvas. */
  get canvases(): HTMLCanvasElement[] {
    return this.slots.map(s => s.canvas);
  }

  /** Opponent i's bottle with its name (e.g. to pop an emote over it). */
  element(i: number): HTMLElement | undefined {
    return this.slots[i]?.wrap;
  }

  /** Effects (flash, shake, incoming blink) for opponent i. */
  fx(i: number): BoardEffects {
    return this.slots[i].fx;
  }

  /** Canvases stay at sprite resolution; CSS scales them by `scale`. */
  size(scale: number): void {
    const { width, height } = boardPixelSize(BOARD_COLS, BOARD_ROWS);
    for (const s of this.slots) {
      s.canvas.width = width;
      s.canvas.height = height;
      s.canvas.style.width = `${Math.round(width * scale)}px`;
      s.canvas.style.height = `${Math.round(height * scale)}px`;
      s.ctx.imageSmoothingEnabled = false;
    }
  }

  update(dt: number): void {
    for (const s of this.slots) s.fx.update(dt);
  }

  /** Draw opponent i (or clear it when view is null, e.g. while paused). */
  draw(i: number, view: BoardView | null, now: number, out: boolean): void {
    const s = this.slots[i];
    if (!s) return;
    s.wrap.classList.toggle('out', out);
    const { x, y } = s.fx.shake(now);
    const k = s.canvas.clientWidth / s.canvas.width || 1;
    const t = x || y ? `translate(${x * k}px, ${y * k}px)` : '';
    if (s.canvas.style.transform !== t) s.canvas.style.transform = t;
    s.ctx.clearRect(0, 0, s.canvas.width, s.canvas.height);
    if (view) drawBoard(s.ctx, view, 0, 0, now);
  }

  reset(): void {
    for (const s of this.slots) s.fx.reset();
  }
}
