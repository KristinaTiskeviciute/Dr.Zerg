import { describe, expect, it } from 'vitest';
import { Speed } from '../config';
import { Game } from '../core/game';
import { Color } from '../core/types';
import { KeyboardInput } from './keyboard';

const STEP = 1000 / 60;

/**
 * A capsule falls down column 6 beside a wall in column 7 that has a 2-cell gap at rows 12–13.
 * The player holds Right the whole way down (pressed while already beside the wall).
 * Does the capsule slide into the gap?
 */
function slidesIn(speed: Speed, softDrop: boolean): boolean {
  const g = new Game({
    level: 0, speed, seed: 1,
    setupBoard: b => {
      b.set(15, 0, { kind: 'germ', color: Color.Blue });
      for (let r = 4; r < 16; r++) {
        if (r === 12 || r === 13) continue;
        b.set(r, 7, { kind: 'germ', color: [Color.Red, Color.Yellow, Color.Blue][r % 3] });
      }
    },
  });
  g.active = { row: 5, col: 6, orientation: 1, colors: [Color.Red, Color.Yellow] }; // vertical, rows 4–5
  const target = new EventTarget();
  const kb = new KeyboardInput();
  kb.attach(target as unknown as Window);
  kb.enabled = true;
  const key = (type: string, code: string) => target.dispatchEvent(Object.assign(new Event(type), { code, repeat: false }));
  key('keydown', 'ArrowRight');
  if (softDrop) key('keydown', 'ArrowDown');
  for (let i = 0; i < 3000 && g.pieceIndex === 0; i++) g.step(STEP, kb.poll(STEP));
  return g.board.get(13, 7)?.kind === 'pill';
}

describe('sliding into a gap while holding toward it', () => {
  for (const speed of ['low', 'med', 'high'] as Speed[]) {
    for (const soft of [false, true]) {
      it(`${speed}${soft ? ' + soft drop' : ''}`, () => {
        expect(slidesIn(speed, soft)).toBe(true);
      });
    }
  }
});
