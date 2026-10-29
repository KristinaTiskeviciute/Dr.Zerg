import { audio } from '../audio/audio';
import { NavDir } from '../input/gamepad';
import { ScreenKeyboard } from './osk';
import { focusables, moveFocus, stepRange } from './padnav';
import { TopBar } from './topbar';

/** Where the selection starts when nothing is selected yet. */
const DEFAULT_CONTROLS = ['.osk button', '#overlay-buttons button', '#ready-btn', '#local-start', '#start', '#create-room'];

/**
 * Getting around menus with a controller (never during play): the D-pad moves the selection,
 * ✕ presses it (or opens the on-screen keyboard on a text box), ○ goes back.
 */
export class PadMenus {
  private readonly osk = new ScreenKeyboard();

  /**
   * `active`: a menu is up (no game, paused, or an overlay with buttons).
   * `joinPad`: ✕ on a controller that hasn't joined a local match yet joins with it (true if it did).
   */
  constructor(private readonly topBar: TopBar, private readonly opts: { active: () => boolean; joinPad: (index: number) => boolean }) {
    // Mouse or keyboard: stop marking the controller's selection.
    for (const type of ['pointerdown', 'keydown']) {
      window.addEventListener(type, () => document.body.classList.remove('pad-nav'), { capture: true });
    }
  }

  navigate(dir: NavDir): void {
    if (!this.opts.active()) return;
    document.body.classList.add('pad-nav');
    const list = this.osk.isOpen ? focusables(this.osk.panel) : focusables();
    const cur = document.activeElement as HTMLElement | null;
    if (!cur || !list.includes(cur)) {
      defaultControl(list)?.focus();
      return;
    }
    if (cur instanceof HTMLInputElement && cur.type === 'range' && (dir === 'left' || dir === 'right')) {
      stepRange(cur, dir === 'right' ? 1 : -1);
      return;
    }
    if (moveFocus(list, dir)) audio.play('move');
    // Left the volume panel: close it.
    if (this.topBar.volumeOpen && !document.activeElement?.closest('.audio-toggles')) this.topBar.closeVolume();
  }

  /** ✕ or Options pressed: true if a menu used it. */
  confirm(button: 'cross' | 'options', index: number): boolean {
    if (!this.opts.active()) return false;
    if (button === 'cross' && this.opts.joinPad(index)) {
      audio.play('rotate');
      return true;
    }
    document.body.classList.add('pad-nav');
    if (this.osk.isOpen && button === 'options') {
      this.osk.done();
      return true;
    }
    const el = document.activeElement;
    if (!(el instanceof HTMLElement) || el.getClientRects().length === 0) return false;
    if (el instanceof HTMLInputElement && el.type === 'text' && !el.closest('.chat-form')) {
      this.osk.open(el);
      return true;
    }
    if (el instanceof HTMLButtonElement && !el.disabled) {
      el.click();
      return true;
    }
    return false;
  }

  back(): void {
    if (!this.opts.active()) return;
    if (this.osk.isOpen) return this.osk.backspace();
    if (this.topBar.volumeOpen) {
      this.topBar.closeVolume();
      this.topBar.volumeButton.focus();
    }
  }
}

function defaultControl(list: HTMLElement[]): HTMLElement | undefined {
  for (const sel of DEFAULT_CONTROLS) {
    const el = list.find(e => e.matches(sel));
    if (el) return el;
  }
  return list[0];
}
