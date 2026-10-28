import { beforeEach, describe, expect, it } from 'vitest';
import { Gesture } from './touch';

const CELL = 20; // px per board cell on screen
const MID = 200; // screen middle

describe('touch gestures', () => {
  let log: string[];
  let g: Gesture;
  beforeEach(() => {
    log = [];
    g = new Gesture({
      nudge: d => log.push(`nudge ${d}`),
      hold: d => log.push(`hold ${d}`),
      softDrop: on => log.push(`drop ${on}`),
      rotate: d => log.push(`rotate ${d}`),
    }, () => CELL, () => MID);
  });

  it('a quick still tap rotates: right half clockwise, left half counter-clockwise', () => {
    g.down(300, 400, 0); g.up(302, 401, 120);
    g.down(100, 400, 500); g.up(100, 400, 600);
    expect(log).toEqual(['rotate cw', 'rotate ccw']);
  });

  it('a long press is not a tap', () => {
    g.down(300, 400, 0); g.up(300, 400, 600);
    expect(log).toEqual([]);
  });

  it('dragging sideways moves one column per 1.1 cells of travel (the first takes 1.3), and keeps pushing', () => {
    g.down(100, 400, 0);
    g.move(124, 400); // 24 px: not far enough for the first column (26 px)
    expect(log).toEqual([]);
    g.move(172, 400); // 72 px = 26 + 22 + 22 (+2)
    expect(log).toEqual(['nudge right', 'hold right', 'nudge right', 'nudge right']);
    g.up(172, 400, 300);
    expect(log.at(-1)).toBe('hold null'); // lifting stops the push, and no rotation
  });

  it('moving back the other way stops pushing before moving that way', () => {
    g.down(100, 400, 0);
    g.move(72, 400); // left: one step (26 px), so the finger "is" at 74
    g.move(86, 400); // back right by more than half a cell
    expect(log).toEqual(['nudge left', 'hold left', 'hold null']);
  });

  it('dragging down soft-drops while the finger stays down there', () => {
    g.down(200, 400, 0);
    g.move(205, 440); // 40 px down = 2 cells
    expect(log).toEqual(['drop true']);
    g.move(205, 410); // back up
    expect(log.at(-1)).toBe('drop false');
    g.move(205, 450);
    g.up(205, 450, 700);
    expect(log.slice(-2)).toEqual(['drop true', 'drop false']);
    expect(log).not.toContain('rotate cw');
  });

  it('sideways wobble while dropping does not move the capsule', () => {
    g.down(200, 400, 0);
    g.move(200, 440); // dropping
    g.move(240, 470); // drifts 40 px sideways
    expect(log).toEqual(['drop true']);
  });

  it('a mostly sideways drag does not start a drop', () => {
    g.down(100, 400, 0);
    g.move(160, 435);
    expect(log).not.toContain('drop true');
  });
});
