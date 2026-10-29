import { CELL_PX } from '../config';
import { Action, KeyboardInput } from '../input/keyboard';
import { TouchControls } from '../input/touch';
import { $, saveSettings, Settings } from './dom';
import { blurUnlessPad } from './padnav';
import { setLabel, showToast } from './topbar';

// Touch controls: opt-in (a switch in the top bar on touchscreens), never assumed.
// Off → on-screen buttons → swipe gestures → off.

const TOUCH_NEXT = { off: 'buttons', buttons: 'swipe', swipe: 'off' } as const;
const TOUCH_LABEL = { off: 'Touch: off', buttons: 'Touch: buttons', swipe: 'Touch: swipe' } as const;

export class TouchUi {
  readonly pad = $('#touch-pad');
  private readonly button = $<HTMLButtonElement>('#toggle-touch');
  private readonly pauseButton = $<HTMLButtonElement>('#touch-pause');

  /**
   * Buttons and gestures drive `keyboard` (in a local match: whoever joined with the keyboard).
   * `canvas` is your board (gestures measure moves in its cells); `live`: the game is running.
   */
  constructor(private readonly settings: Settings, keyboard: KeyboardInput, canvas: HTMLCanvasElement, opts: { onPause: () => void; live: () => boolean }) {
    this.button.addEventListener('click', () => {
      settings.touch = TOUCH_NEXT[settings.touch];
      saveSettings(settings);
      this.render();
      showToast(TOUCH_LABEL[settings.touch]);
      blurUnlessPad(this.button);
    });

    // Touch buttons: held like keys (◀ ▶ repeat after a moment, ▼ drops while held), several at once.
    for (const b of this.pad.querySelectorAll<HTMLButtonElement>('.tbtn')) {
      const action = b.dataset.action as Action;
      b.addEventListener('pointerdown', e => {
        e.preventDefault();
        b.setPointerCapture(e.pointerId);
        b.classList.add('down');
        keyboard.press(action);
      });
      const up = () => {
        if (!b.classList.contains('down')) return;
        b.classList.remove('down');
        keyboard.release(action);
      };
      b.addEventListener('pointerup', up);
      b.addEventListener('pointercancel', up);
      b.addEventListener('lostpointercapture', up);
      b.addEventListener('contextmenu', e => e.preventDefault());
    }
    this.pauseButton.addEventListener('click', () => { opts.onPause(); this.pauseButton.blur(); });
    this.render();

    new TouchControls({
      nudge: dir => keyboard.nudge(dir),
      hold: dir => keyboard.setTouchHold(dir),
      softDrop: on => (on ? keyboard.press('softDrop') : keyboard.release('softDrop')),
      rotate: dir => {
        const action = dir === 'cw' ? 'rotateCW' : 'rotateCCW';
        keyboard.press(action);
        keyboard.release(action);
      },
    }, () => (canvas.clientWidth / canvas.width) * CELL_PX || 24, () => settings.touch === 'swipe' && opts.live());
  }

  /** The on-screen buttons are showing (touch buttons on, in a game). */
  buttonsShown(inGame: boolean): boolean {
    return this.settings.touch === 'buttons' && inGame;
  }

  /** Every frame: the pause button, the touch buttons and "no scrolling" only while touch controls are on in a game. */
  update(inGame: boolean): void {
    const on = this.settings.touch !== 'off' && inGame;
    if (this.pauseButton.classList.contains('hidden') === on) this.pauseButton.classList.toggle('hidden', !on);
    const pad = this.buttonsShown(inGame);
    if (this.pad.classList.contains('hidden') === pad) this.pad.classList.toggle('hidden', !pad);
    document.body.classList.toggle('touch-play', on);
  }

  /** A reminder of the gestures on the countdown (swipe controls on). */
  get tip(): string {
    return this.settings.touch === 'swipe' ? ' · drag to move, tap to rotate' : '';
  }

  private render(): void {
    const touch = this.settings.touch;
    this.button.classList.toggle('hidden', navigator.maxTouchPoints === 0);
    setLabel(this.button, touch === 'buttons' ? '🔘' : '👆', TOUCH_LABEL[touch]);
    this.button.classList.toggle('off', touch === 'off');
    $('#touch-hint').classList.toggle('hidden', touch === 'off');
    $('#touch-hint-text').textContent = touch === 'buttons'
      ? '🔘 Touch buttons: ◀ ▶ move (hold to repeat) · ▼ drop (hold) · ↺ ↻ rotate · ⏸ pause'
      : '👆 Touch: drag sideways to move · tap to rotate (left side ↺, right side ↻) · drag down and hold to drop · ⏸ pause';
  }
}
