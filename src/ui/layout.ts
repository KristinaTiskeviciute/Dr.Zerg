import { OPPONENT_BOARD_SCALE } from '../config';
import { BOTTLE_SHOULDER_PX, boardPixelSize } from '../render/draw';
import { $ } from './dom';
import { OpponentBoards } from './opponents';

/** What the board sizes depend on, besides the page size. */
export interface LayoutOptions {
  /** The touch buttons are showing (they need room). */
  pad: boolean;
  /** A local match: everyone's bottle is the same size. */
  local: boolean;
}

/**
 * Sizes the boards: yours fills the window height, leaving room for the HUD and the opponents'
 * bottles (full size against one opponent, smaller against two or three). Phones get their own
 * layouts: portrait (the others in a row) and landscape (the others to the right).
 */
export class BoardLayout {
  private readonly ctx: CanvasRenderingContext2D;
  /** The page size the boards were last sized for. */
  private sizedFor = '';

  /** `chatWidth`: room kept free at the right edge for the chat dock. */
  constructor(
    private readonly canvas: HTMLCanvasElement,
    private readonly opponents: OpponentBoards,
    private readonly touchPad: HTMLElement,
    private readonly chatWidth: () => number,
  ) {
    this.ctx = canvas.getContext('2d')!;
  }

  /**
   * The page changed size since the last layout. Phones don't always send a resize event (e.g.
   * while a page is still settling), so the game checks this every frame.
   */
  stale(o: LayoutOptions): boolean {
    return this.sizedFor !== this.key(o);
  }

  /** Lay out the boards. Show or hide the touch buttons first, so they can be measured. */
  size(o: LayoutOptions): void {
    const { canvas, opponents, touchPad } = this;
    const { w: viewW, h: viewH } = viewSize();
    this.sizedFor = this.key(o);
    const { width, height } = boardPixelSize(8, 16);
    // Room for the touch buttons: along the bottom, or (landscape phones) down the sides.
    const { pad, local } = o;
    const n = opponents.count;
    const oppScale = n <= 1 || local ? OPPONENT_BOARD_SCALE : n === 2 ? 0.6 : 0.5;
    const setSizes = (yours: number, theirs: number) => {
      canvas.width = width;
      canvas.height = height;
      canvas.style.width = `${Math.round(width * yours)}px`;
      canvas.style.height = `${Math.round(height * yours)}px`;
      this.ctx.imageSmoothingEnabled = false;
      opponents.size(theirs);
    };

    // Phones: your bottle between the stats columns. Portrait puts the others in a row below,
    // landscape (a short screen) puts them to the right.
    const portrait = viewW <= 520;
    const landscape = !portrait && viewH <= 520;
    const play = $('#play');
    play.classList.toggle('compact', portrait || landscape);
    play.classList.toggle('portrait', portrait);
    play.classList.toggle('landscape', landscape);
    play.classList.toggle('buttons', pad);
    touchPad.classList.toggle('sides', landscape);
    // The whole panel's height, including its padding for the iPhone home bar (safe area), plus a little gap.
    const padH = pad && !landscape ? touchPad.offsetHeight + 8 : 0;
    const padW = pad && landscape ? touchPad.querySelector<HTMLElement>('.cluster')!.offsetWidth + 24 : 0;
    play.style.setProperty('--pad-h', `${padH}px`);
    play.style.setProperty('--pad-w', `${padW}px`);
    const left = $('.hud-left').offsetWidth;
    const right = $('.hud-right').offsetWidth;

    if (local) {
      // Everyone equal: every bottle the same size, between the stats columns at the edges. One row,
      // except portrait phones: two players stacked, three or four in a 2×2 grid.
      const bottles = n + 1;
      const cols = portrait ? (bottles <= 2 ? 1 : 2) : bottles;
      const rows = Math.ceil(bottles / cols);
      play.style.setProperty('--cols', String(cols));
      const gapX = portrait ? 10 : landscape ? 12 : 24;
      const labelRow = 34; // each bottle's name label below it
      const sides = portrait ? 2 * Math.max(left, right) : left + right; // portrait: equal columns, so the grid is centred
      const availW = viewW - this.chatWidth() - 2 * padW - 32 - sides - gapX * (cols + 1) - 6;
      const top = portrait ? (pad ? 52 : 64) : landscape ? 52 : 48;
      const availH = viewH - top - rows * labelRow - 12 - padH;
      const fit = Math.min(availW / (cols * width), availH / (rows * height));
      // Big screens: whole-number scales keep every pixel the same size, so prefer one when it's close.
      let scale = Math.max(0.3, fit >= 1 && fit - Math.floor(fit) < 0.35 ? Math.floor(fit) : fit);
      play.style.setProperty('--shoulder', `${Math.round(BOTTLE_SHOULDER_PX * scale)}px`);
      setSizes(scale, scale);
      // Touch buttons in portrait: the same safety check as below, for the lowest row of bottles.
      if (pad && portrait) {
        for (let tries = 0; tries < 10; tries++) {
          const over = this.lowestBottle() + 10 - this.buttonsTop();
          if (over <= 0) break;
          scale *= Math.max(0.7, 1 - over / (rows * height * scale));
          play.style.setProperty('--shoulder', `${Math.round(BOTTLE_SHOULDER_PX * scale)}px`);
          setSizes(scale, scale);
        }
      }
      return;
    }

    if (portrait || landscape) {
      const availW = viewW - this.chatWidth() - 2 * padW;
      let yours: number;
      let theirs: number;
      if (portrait) {
        // Equal side columns (so your bottle is centred): room for the wider one twice.
        const side = Math.min(240, 2 * Math.max(left, right) + 20);
        yours = (availW - 32 - side - 6) / width; // a few px spare for rounding
        theirs = n ? Math.min(yours * (local ? 1 : oppScale), (availW - 32 - (n - 1) * 8 - 6) / (n * width)) : 0;
        // Both rows have to fit the height too (minus padding and the name labels).
        const availH = viewH - (pad ? 52 : 64) - 36 - (local ? 22 : 0) - (n ? 34 : 0) - padH;
        const shrink = availH / (yours * height + theirs * height);
        if (shrink < 1) { yours *= shrink; theirs *= shrink; }
      } else {
        // One row, as tall as the screen allows (minus padding and the name labels below).
        // The others use whatever width is left, up to the size of yours.
        yours = (viewH - 52 - 12 - 30) / height;
        const room = availW - 24 - left - right - 12 * 3 - Math.max(0, n - 1) * 10 - 6;
        theirs = n ? Math.min(yours, (room - yours * width) / (n * width)) : 0;
        if (n && theirs < yours * oppScale) {
          // Not even room for the usual smaller size: shrink everything to fit.
          theirs = yours * oppScale;
          const shrink = room / (yours * width + n * theirs * width);
          yours *= shrink;
          theirs *= shrink;
        }
      }
      yours = Math.max(0.5, yours);
      // The side columns start level with your bottle's shoulders, not the preview above them.
      play.style.setProperty('--shoulder', `${Math.round(BOTTLE_SHOULDER_PX * yours)}px`);
      setSizes(yours, Math.max(0.3, theirs));
      // Safety check (portrait with buttons): browsers don't all agree on how much of the screen is
      // visible, so measure where things ended up and shrink until your bottle clears the buttons.
      if (pad && portrait) {
        for (let tries = 0; tries < 10; tries++) {
          const over = canvas.getBoundingClientRect().bottom + 10 - this.buttonsTop();
          if (over <= 0) break;
          // Shrink both rows by about the overlap and measure again. The bottle's bottom moves up by
          // somewhere between half (page centred) and all of that, so this never overshoots.
          const k = Math.max(0.7, 1 - over / (yours * height + theirs * height));
          yours *= k;
          theirs *= k;
          play.style.setProperty('--shoulder', `${Math.round(BOTTLE_SHOULDER_PX * yours)}px`);
          setSizes(yours, Math.max(0.3, theirs));
        }
      }
      return;
    }

    const availW = viewW - 260 - n * 32 - this.chatWidth();
    // Leave room for the page padding, and in versus for the opponents' names under their bottles.
    const availH = viewH - 56 - (n ? 32 : 0) - padH;
    // The canvases stay at sprite resolution; CSS scales them up with crisp (pixelated) edges.
    // Whole-number scales keep every pixel the same size, so prefer one when it's close.
    const fit = Math.max(1, Math.min(availW / (width * (1 + n * oppScale)), availH / height));
    const scale = fit - Math.floor(fit) < 0.35 ? Math.floor(fit) : fit;
    setSizes(scale, scale * oppScale);
  }

  /** Where the touch buttons start (the top of the higher cluster). */
  private buttonsTop(): number {
    return Math.min(...[...this.touchPad.querySelectorAll<HTMLElement>('.cluster')].map(c => c.getBoundingClientRect().top));
  }

  /** The bottom of the lowest bottle on screen (yours or anyone's). */
  private lowestBottle(): number {
    return Math.max(...[this.canvas, ...this.opponents.canvases].map(c => c.getBoundingClientRect().bottom));
  }

  /** The page size and the touch buttons' room (if showing). */
  private key(o: LayoutOptions): string {
    const { w, h } = viewSize();
    return `${w}x${h}:${o.pad ? this.touchPad.offsetHeight : 'no buttons'}`;
  }
}

/**
 * The part of the page you can see. The layout size (unlike innerWidth/innerHeight) isn't changed
 * by pinch-zooming, but some phone browsers count the space behind their bottom toolbar in it, so
 * the height is whichever is smaller.
 */
function viewSize(): { w: number; h: number } {
  const el = document.documentElement;
  return { w: el.clientWidth, h: Math.min(el.clientHeight, window.innerHeight || el.clientHeight) };
}
