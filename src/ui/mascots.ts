import { COLORS } from '../core/types';
import { drawGerm } from '../render/draw';
import { $ } from './dom';

/** The title screen's three germs, hopping in turn. */
export class Mascots {
  private readonly canvas = $<HTMLCanvasElement>('#mascots');
  private readonly ctx = this.canvas.getContext('2d')!;

  constructor() {
    this.canvas.width = 16 * 3 + 8 * 2;
    this.canvas.height = 20;
  }

  draw(now: number): void {
    this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
    COLORS.forEach((color, i) => {
      const beat = Math.floor(now / 300 + i) % 3;
      drawGerm(this.ctx, i * 24, beat === 0 ? 1 : 4, color, beat === 0 ? 1 : 0);
    });
  }
}
