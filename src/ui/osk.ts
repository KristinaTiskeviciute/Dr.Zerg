import { usingPad } from './padnav';

const ROWS = ['ABCDEFGHIJ', 'KLMNOPQRST', 'UVWXYZ0123', '456789-_.!'];

/**
 * An on-screen keyboard for typing your name (or a room code) with a controller. Opens when
 * you press ✕ on a text box; D-pad picks a key, ✕ types, ◯ deletes, Options or Done finishes.
 */
export class ScreenKeyboard {
  readonly panel: HTMLElement;
  private readonly label: HTMLElement;
  private readonly preview: HTMLElement;
  private readonly letterKeys: [HTMLButtonElement, string][] = [];
  private target: HTMLInputElement | null = null;
  /** Capitals for the next letter (on for the first letter, like a phone keyboard). */
  private shift = true;

  constructor() {
    this.panel = document.createElement('div');
    this.panel.className = 'osk hidden';
    this.label = document.createElement('span');
    this.label.className = 'label';
    this.preview = document.createElement('div');
    this.preview.className = 'osk-preview';
    const keys = document.createElement('div');
    keys.className = 'osk-keys';
    const key = (text: string, onPress: () => void, cls = '') => {
      const b = document.createElement('button');
      b.type = 'button';
      b.textContent = text;
      if (cls) b.className = cls;
      b.addEventListener('click', onPress);
      return b;
    };
    for (const row of ROWS) {
      for (const ch of row) {
        const b = key(ch, () => this.type(ch));
        this.letterKeys.push([b, ch]);
        keys.append(b);
      }
    }
    keys.append(
      key('Aa', () => { this.shift = !this.shift; this.render(); }, 'wide2'),
      key('Space', () => this.type(' '), 'wide4'),
      key('⌫', () => this.backspace(), 'wide2'),
      key('Done', () => this.done(), 'wide2 primary'),
    );
    this.panel.append(this.label, this.preview, keys);
    document.body.append(this.panel);
    // Clicking outside (with a mouse) finishes too.
    document.addEventListener('pointerdown', e => {
      if (this.isOpen && !this.panel.contains(e.target as Node)) this.done();
    });
  }

  get isOpen(): boolean {
    return this.target !== null;
  }

  open(input: HTMLInputElement): void {
    this.target = input;
    this.shift = input.value.length === 0;
    this.label.textContent = input.labels?.[0]?.textContent?.trim() || input.placeholder || 'Type';
    this.panel.classList.remove('hidden');
    this.render();
    if (usingPad()) this.letterKeys[0][0].focus();
  }

  type(ch: string): void {
    const t = this.target;
    if (!t) return;
    if (t.maxLength > 0 && Array.from(t.value).length >= t.maxLength) return;
    const isLetter = /[A-Z]/.test(ch);
    t.value += isLetter && !this.shift ? ch.toLowerCase() : ch;
    if (isLetter) this.shift = false;
    t.dispatchEvent(new Event('input', { bubbles: true }));
    this.render();
  }

  backspace(): void {
    const t = this.target;
    if (!t) return;
    t.value = Array.from(t.value).slice(0, -1).join('');
    t.dispatchEvent(new Event('input', { bubbles: true }));
    this.render();
  }

  /** Finish: close, let the page know the value changed, and go back to the text box. */
  done(): void {
    const t = this.target;
    if (!t) return;
    this.target = null;
    this.panel.classList.add('hidden');
    t.dispatchEvent(new Event('change', { bubbles: true }));
    if (usingPad()) t.focus();
  }

  private render(): void {
    if (!this.target) return;
    this.preview.textContent = `${this.target.value}▌`;
    for (const [b, ch] of this.letterKeys) b.textContent = this.shift ? ch : ch.toLowerCase();
  }
}
