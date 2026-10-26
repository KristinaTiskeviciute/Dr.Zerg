import { LobbyPlayer } from '../net/protocol';
import { VoiceChat } from '../net/voice';

/**
 * The voice controls at the top of the chat tab: join / mute / leave, and everyone in voice
 * with a dot that lights up while they talk.
 */
export class VoiceBar {
  private readonly joinBtn: HTMLButtonElement;
  private readonly muteBtn: HTMLButtonElement;
  private readonly leaveBtn: HTMLButtonElement;
  private readonly note: HTMLElement;
  private readonly list: HTMLElement;
  private players: LobbyPlayer[] = [];
  private dots = new Map<string, HTMLElement>();

  constructor(slot: HTMLElement, private readonly voice: VoiceChat, private readonly me: string) {
    const row = document.createElement('div');
    row.className = 'voice-row';
    const button = (text: string, onClick: () => void) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.textContent = text;
      b.addEventListener('click', () => { onClick(); b.blur(); });
      return b;
    };
    this.joinBtn = button('🎤 Join voice', () => void voice.join());
    this.muteBtn = button('', () => voice.toggleMute());
    this.muteBtn.title = 'Mute / unmute (V, or Create on a controller)';
    this.leaveBtn = button('Leave', () => voice.leave());
    this.leaveBtn.className = 'quiet';
    row.append(this.joinBtn, this.muteBtn, this.leaveBtn);
    this.note = document.createElement('p');
    this.note.className = 'voice-note';
    this.list = document.createElement('ul');
    this.list.className = 'voice-list';
    slot.append(row, this.list, this.note);
    this.render();
  }

  setPlayers(players: LobbyPlayer[]): void {
    this.players = players;
    this.render();
  }

  /** Short marker for the collapsed chat tab. */
  get tabIcon(): string {
    if (this.voice.status !== 'on') return '';
    return this.voice.muted || this.voice.listenOnly ? '🔇' : '🎤';
  }

  render(): void {
    const v = this.voice;
    const on = v.status === 'on';
    this.joinBtn.classList.toggle('hidden', on);
    this.joinBtn.disabled = v.status === 'joining';
    this.joinBtn.textContent = v.status === 'joining' ? 'Joining…' : '🎤 Join voice';
    this.muteBtn.classList.toggle('hidden', !on || v.listenOnly);
    this.muteBtn.textContent = v.muted ? '🔇 Muted' : '🎤 Mic on';
    this.muteBtn.classList.toggle('off', v.muted);
    this.leaveBtn.classList.toggle('hidden', !on);

    this.note.textContent =
      !on ? 'Talk while you play. Headphones recommended.' :
      v.listenOnly ? 'No microphone access: listening only. Allow the mic in the address bar and rejoin.' : '';

    // Everyone in voice: you first, then the others with their connection state.
    this.dots.clear();
    const inVoice = on ? this.players.filter(p => p.voice && p.connected && (p.id !== this.me)) : [];
    const items = on ? [{ id: this.me, name: 'You', state: '' }, ...inVoice.map(p => ({
      id: p.id,
      name: p.name,
      state: v.peerState(p.id) === 'connected' ? '' : v.peerState(p.id) === 'failed' ? "can't connect" : 'connecting…',
    }))] : this.players.filter(p => p.voice && p.connected).map(p => ({ id: p.id, name: p.name, state: '' }));
    this.list.replaceChildren(...items.map(item => {
      const li = document.createElement('li');
      const dot = document.createElement('span');
      dot.className = 'dot';
      this.dots.set(item.id, dot);
      const name = document.createElement('span');
      name.className = 'name';
      name.textContent = item.name;
      li.append(dot, name);
      if (item.state) {
        const st = document.createElement('span');
        st.className = 'state';
        st.textContent = item.state;
        li.append(st);
      }
      return li;
    }));
  }

  /** Every frame: light up whoever's talking. */
  tick(): void {
    if (this.voice.status !== 'on') return;
    for (const [id, dot] of this.dots) {
      const talking = this.voice.speaking(id);
      if (dot.classList.contains('talking') !== talking) dot.classList.toggle('talking', talking);
    }
  }
}
