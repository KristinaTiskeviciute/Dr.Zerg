import { audio } from '../audio/audio';
import { isTyping } from './chat';
import { $ } from './dom';

export type OverlayButtons = [string, () => void][];

/**
 * The box over the boards: countdowns, pause, results. Its buttons work with the mouse, the
 * keyboard (↑/↓, Enter, Space) and a controller (through the page's focus).
 */
export class Overlay {
  /** Which kind of overlay setState() last showed ('' = none, or one shown some other way). */
  key = '';
  private readonly el = $('#overlay');
  private readonly buttonBox = $('#overlay-buttons');
  private timer: ReturnType<typeof setTimeout> | undefined;

  /** `live`: the game is running (the overlay's keys are left to the game then). */
  constructor(private readonly live: () => boolean) {
    window.addEventListener('keydown', e => this.onKey(e));
  }

  get visible(): boolean {
    return !this.el.classList.contains('hidden');
  }

  /** Showing, with buttons to pick (pause, between rounds). */
  get hasButtons(): boolean {
    return this.visible && this.buttonBox.querySelector('button') !== null;
  }

  /**
   * `quiet`: the buttons are an aside (no main button, nothing selected): a stray ✕ or Enter
   * right after a round can't press them.
   */
  show(title: string, sub: string, buttons: OverlayButtons, quiet = false): void {
    clearTimeout(this.timer);
    $('#overlay-title').textContent = title;
    $('#overlay-sub').textContent = sub;
    this.buttonBox.replaceChildren(
      ...buttons.map(([label, onClick]) => {
        const b = document.createElement('button');
        b.type = 'button';
        b.textContent = label;
        b.addEventListener('click', onClick);
        return b;
      }),
    );
    this.el.classList.remove('hidden');
    if (quiet) {
      for (const b of this.buttonBox.children) b.classList.add('quiet');
      return;
    }
    this.buttonBox.firstElementChild?.classList.add('primary');
    (this.buttonBox.firstElementChild as HTMLButtonElement | null)?.focus();
  }

  /** Show after a delay (e.g. so the boards stay visible for a moment after a round). */
  showLater(ms: number, title: string, sub: string, buttons: OverlayButtons, quiet = false): void {
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this.show(title, sub, buttons, quiet), ms);
  }

  hide(): void {
    clearTimeout(this.timer);
    this.el.classList.add('hidden');
  }

  /** Show this kind unless it's already showing; the same kind just updates its text. */
  setState(key: string, title: string, sub: string, buttons: OverlayButtons): void {
    if (this.key === key) {
      setText('#overlay-title', title);
      setText('#overlay-sub', sub);
      return;
    }
    this.key = key;
    this.show(title, sub, buttons);
  }

  /** Hide the overlay that setState() showed, if this kind (or any kind) is up. */
  clearState(key?: string): void {
    if (!this.key || (key !== undefined && this.key !== key)) return;
    this.key = '';
    this.hide();
  }

  /** Move focus between the buttons (keyboard ↑/↓, controller D-pad / stick). */
  private navigate(dir: -1 | 1): boolean {
    if (this.live() || !this.visible) return false;
    const buttons = [...this.buttonBox.querySelectorAll<HTMLButtonElement>('button')].filter(b => !b.disabled);
    if (buttons.length === 0) return false;
    const i = buttons.indexOf(document.activeElement as HTMLButtonElement);
    const next = i < 0 ? (dir > 0 ? 0 : buttons.length - 1) : (i + dir + buttons.length) % buttons.length;
    buttons[next].focus();
    if (next !== i) audio.play('move');
    return true;
  }

  private onKey(e: KeyboardEvent): void {
    if (isTyping(e) || !this.visible || this.live()) return;
    if (e.code === 'ArrowUp' || e.code === 'ArrowDown') {
      if (this.navigate(e.code === 'ArrowUp' ? -1 : 1)) e.preventDefault();
    } else if ((e.code === 'Enter' || e.code === 'Space') && !e.repeat) {
      // Space would normally click on release, but the game keeps Space for itself.
      const el = document.activeElement;
      if (el instanceof HTMLButtonElement && el.closest('#overlay-buttons')) {
        e.preventDefault();
        el.click();
      }
    }
  }
}

function setText(id: string, text: string): void {
  const el = $(id);
  if (el.textContent !== text) el.textContent = text;
}
