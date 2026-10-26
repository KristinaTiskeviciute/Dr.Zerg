import { ChatLine, ClientMessage, EMOTES, MAX_CHAT_LENGTH } from '../net/protocol';

/** How long a big emote stays on screen. */
const EMOTE_MS = 2200;
const OPEN_KEY = 'drzerg.chatOpen';
/** Below this window width the open chat covers the game instead of taking room beside it. */
const OVERLAY_BELOW_PX = 760;
/** Room the dock takes at the right edge: collapsed (just the tab) and open. */
const TAB_PX = 44;
const OPEN_PX = 340;

/** True if the key went to a text field (so game and shortcut keys should leave it alone). */
export function isTyping(e: Event): boolean {
  const t = e.target;
  if (typeof HTMLElement === 'undefined') return false; // tests run without a DOM
  return t instanceof HTMLTextAreaElement || (t instanceof HTMLInputElement && t.type === 'text');
}

/**
 * The room chat, docked at the right edge: a tab that opens into recent lines, a text box and
 * a row of emotes. Shown in online rooms; you can read it any time, but typing and emotes only
 * work outside of play (lobby, pause, between rounds).
 */
export class ChatBox {
  private readonly dock: HTMLElement;
  private readonly log: HTMLElement;
  private readonly input: HTMLInputElement;
  private readonly badge: HTMLElement;
  private readonly emoteButtons: HTMLButtonElement[] = [];
  private shown = false;
  private open = true;
  private canSend = false;
  private unread = 0;

  /** onLayout: the room the dock takes changed (resize the boards). */
  constructor(
    private readonly me: string,
    private readonly send: (msg: ClientMessage) => void,
    private readonly onLayout: () => void,
  ) {
    try {
      this.open = localStorage.getItem(OPEN_KEY) !== '0';
    } catch { /* storage unavailable */ }

    this.dock = document.createElement('aside');
    this.dock.className = 'chat-dock hidden';

    const tab = document.createElement('button');
    tab.type = 'button';
    tab.className = 'chat-tab';
    tab.title = 'Show or hide the chat';
    const tabText = document.createElement('span');
    tabText.textContent = 'Chat';
    this.badge = document.createElement('span');
    this.badge.className = 'badge hidden';
    tab.append(tabText, this.badge);
    tab.addEventListener('click', () => { this.setOpen(!this.open); tab.blur(); });

    const body = document.createElement('div');
    body.className = 'chat';
    this.log = document.createElement('ul');
    this.log.className = 'chat-log';

    const form = document.createElement('form');
    form.className = 'chat-form';
    this.input = document.createElement('input');
    this.input.type = 'text';
    this.input.maxLength = MAX_CHAT_LENGTH;
    this.input.autocomplete = 'off';
    this.input.setAttribute('aria-label', 'Chat message');
    form.append(this.input);
    form.addEventListener('submit', e => {
      e.preventDefault();
      const text = this.input.value.trim();
      if (!text) return this.input.blur();
      if (this.canSend) this.send({ t: 'chat', text });
      this.input.value = '';
    });
    this.input.addEventListener('keydown', e => {
      if (e.key === 'Escape') this.input.blur();
    });

    const emotes = document.createElement('div');
    emotes.className = 'emotes';
    EMOTES.forEach((emoji, i) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.textContent = emoji;
      b.title = `Key ${i + 1}`;
      b.addEventListener('click', () => { this.emote(i); b.blur(); });
      this.emoteButtons.push(b);
      emotes.append(b);
    });

    body.append(this.log, form, emotes);
    this.dock.append(tab, body);
    document.body.append(this.dock);
    window.addEventListener('resize', () => this.render()); // narrow windows don't keep room for it
    this.render();
  }

  /** Show the dock (in an online room) or hide it. */
  show(shown: boolean): void {
    if (shown === this.shown) return;
    this.shown = shown;
    if (!shown) this.blur();
    this.render();
    this.onLayout();
  }

  /** Allow typing and emotes (outside of play), or make the chat read-only. */
  setEnabled(enabled: boolean): void {
    if (enabled === this.canSend) return;
    this.canSend = enabled;
    if (!enabled) this.blur(); // never leave keys going to the text box during play
    this.render();
  }

  get enabled(): boolean {
    return this.shown && this.canSend;
  }

  /** Width the dock takes at the right edge of the window (0 when it covers the game instead). */
  get reservedWidth(): number {
    if (!this.shown || window.innerWidth < OVERLAY_BELOW_PX) return this.shown ? TAB_PX : 0;
    return this.open ? OPEN_PX : TAB_PX;
  }

  /** Start typing (opens the chat if it's collapsed). */
  focus(): void {
    if (!this.enabled) return;
    if (!this.open) this.setOpen(true);
    this.input.focus();
  }

  emote(i: number): void {
    if (this.enabled) this.send({ t: 'emote', e: i });
  }

  add(line: ChatLine, isNew = true): void {
    const li = document.createElement('li');
    const who = document.createElement('b');
    who.textContent = line.name;
    li.classList.toggle('mine', line.from === this.me);
    li.append(who, ' ', line.text);
    this.log.append(li);
    if (isNew && line.from !== this.me && !this.open) {
      this.unread++;
      this.render();
    }
    this.scrollDown();
  }

  setHistory(lines: ChatLine[]): void {
    this.log.replaceChildren();
    for (const line of lines) this.add(line, false);
  }

  private setOpen(open: boolean): void {
    this.open = open;
    if (open) this.unread = 0;
    else this.blur();
    try {
      localStorage.setItem(OPEN_KEY, open ? '1' : '0');
    } catch { /* ignore */ }
    this.render();
    this.scrollDown();
    this.onLayout();
  }

  private blur(): void {
    if (document.activeElement === this.input) this.input.blur();
  }

  private render(): void {
    this.dock.classList.toggle('hidden', !this.shown);
    this.dock.classList.toggle('open', this.open);
    document.body.style.setProperty('--chat-room', `${this.reservedWidth}px`);
    this.badge.textContent = String(this.unread);
    this.badge.classList.toggle('hidden', this.unread === 0);
    this.input.disabled = !this.canSend;
    this.input.placeholder = this.canSend ? 'Say something… (T)' : 'Chat opens between rounds';
    for (const b of this.emoteButtons) b.disabled = !this.canSend;
  }

  private scrollDown(): void {
    this.log.scrollTop = this.log.scrollHeight;
  }
}

/** Pop an emote up big over `container` (a bottle or the lobby), with who sent it. */
export function popEmote(container: HTMLElement, e: number, name: string): void {
  const emoji = EMOTES[e];
  if (!emoji) return;
  container.querySelector(':scope > .emote-pop')?.remove();
  const pop = document.createElement('div');
  pop.className = 'emote-pop';
  const big = document.createElement('span');
  big.className = 'emoji';
  big.textContent = emoji;
  const who = document.createElement('span');
  who.className = 'who';
  who.textContent = name;
  pop.append(big, who);
  container.append(pop);
  setTimeout(() => pop.remove(), EMOTE_MS);
}
