import { Speed } from '../config';
import { ConnectionStatus, playerId, RoomConnection } from '../net/client';
import { ClientMessage, LobbyState, MAX_PLAYERS, MIN_PLAYERS, ServerMessage, StartInfo } from '../net/protocol';
import { $, saveSettings, Settings, SPEED_LABEL } from './dom';

const SLOW_CONNECT_MS = 5000;

/** Messages that matter during a match (boards, garbage, results, pause, disconnects). */
export type MatchMessage = Extract<ServerMessage, { t: 'board' | 'garbage' | 'out' | 'round' | 'pause' | 'away' | 'back' }>;

export interface RoomCallbacks {
  /** A round starts (first round from the lobby, later rounds automatically). */
  onStart(info: StartInfo): void;
  onMatchMessage(msg: MatchMessage): void;
  /** True while you're actually playing a round on this tab. */
  inMatch(): boolean;
  /** You left the room (or were turned away): back to the menu. */
  onLeave(error?: string): void;
}

/**
 * The online lobby screen and its connection to one room at a time.
 * Created once; enter(code) joins a room, leave() goes back to the menu.
 */
export class OnlineRoom {
  readonly me = playerId();
  private conn: RoomConnection | null = null;
  private lobby: LobbyState | null = null;
  private status: ConnectionStatus = 'closed';
  private setupSent = false;
  /** When the current attempt to connect started (to notice a server that never answers). */
  private connectingSince = 0;
  /** Already gave up the round in progress (rejoined mid-round without a game). */
  private forfeited = false;

  constructor(private readonly settings: Settings, private readonly cb: RoomCallbacks) {
    this.bindUi();
    window.addEventListener('popstate', () => {
      if (this.conn && !location.pathname.startsWith('/r/')) this.leave();
    });
  }

  get code(): string | null {
    return this.conn?.code ?? null;
  }

  get connected(): boolean {
    return this.status === 'open';
  }

  send(msg: ClientMessage): void {
    this.conn?.send(msg);
  }

  enter(code: string): void {
    this.conn?.close();
    this.lobby = null;
    this.setupSent = false;
    if (location.pathname !== `/r/${code}`) history.pushState(null, '', `/r/${code}`);
    this.conn = new RoomConnection(
      code,
      () => ({ t: 'join', playerId: this.me, name: this.settings.name || 'Player' }),
      msg => this.onMessage(msg),
      status => {
        if (status !== this.status && (status === 'connecting' || status === 'reconnecting')) {
          if (this.status !== 'connecting' && this.status !== 'reconnecting') this.connectingSince = performance.now();
        }
        this.status = status;
        if (status !== 'open') this.setupSent = false; // re-send our setup after reconnecting
        this.render();
      },
    );
    this.conn.connect();
    this.show();
    // If it still hasn't connected after a while, say so instead of "Connecting…" forever.
    setTimeout(() => this.render(), SLOW_CONNECT_MS + 50);
  }

  leave(error?: string): void {
    this.conn?.close();
    this.conn = null;
    this.lobby = null;
    if (location.pathname.startsWith('/r/')) history.pushState(null, '', '/');
    this.cb.onLeave(error);
  }

  /** After a match: everyone back to the lobby with the same settings. */
  backToLobby(): void {
    this.conn?.send({ t: 'backToLobby' });
    this.show();
  }

  show(): void {
    for (const id of ['#menu', '#play']) $(id).classList.add('hidden');
    $('#lobby').classList.remove('hidden');
    $('#room-code').textContent = this.conn?.code ?? '----';
    $<HTMLInputElement>('#lobby-name').value = this.settings.name;
    this.render();
  }

  // --- server messages ---

  private onMessage(msg: ServerMessage): void {
    switch (msg.t) {
      case 'lobby':
        this.lobby = msg.lobby;
        $('#lobby-error').textContent = '';
        // Tell the room our level/speed once we have a seat (and after every reconnect).
        if (!this.setupSent && this.mine() && msg.lobby.phase === 'lobby') {
          this.setupSent = true;
          this.sendSetup();
        }
        // Back in a room whose round is in progress, but this tab has no game (e.g. after a
        // reload): give up this round so the match can go on; you'll play the next one.
        if (msg.lobby.phase === 'playing' && this.mine() && !this.cb.inMatch() && !this.forfeited) {
          this.forfeited = true;
          this.send({ t: 'result', outcome: 'forfeit' });
        }
        if (msg.lobby.phase === 'lobby') this.forfeited = false;
        this.render();
        break;
      case 'start':
        this.forfeited = false;
        this.cb.onStart(msg);
        break;
      case 'board':
      case 'garbage':
      case 'round':
      case 'pause':
      case 'away':
      case 'back':
      case 'out':
        this.cb.onMatchMessage(msg);
        break;
      case 'error':
        console.warn(`[room ${this.code}] server says: ${msg.code}: ${msg.message}`);
        if (msg.code === 'full' || msg.code === 'inProgress') this.leave(msg.message);
        else $('#lobby-error').textContent = msg.message;
        break;
    }
  }

  private mine() {
    return this.lobby?.players.find(p => p.id === this.me);
  }

  private sendSetup(): void {
    this.conn?.send({ t: 'setup', level: this.settings.level, speed: this.settings.speed });
  }

  // --- screen ---

  private bindUi(): void {
    $('#copy-link').addEventListener('click', async () => {
      if (!this.code) return;
      const url = `${location.origin}/r/${this.code}`;
      try {
        await navigator.clipboard.writeText(url);
        $('#copy-link').textContent = 'Copied!';
      } catch {
        $('#copy-link').textContent = url;
      }
      setTimeout(() => { $('#copy-link').textContent = 'Copy link'; }, 2000);
    });

    const nameInput = $<HTMLInputElement>('#lobby-name');
    nameInput.addEventListener('change', () => {
      this.settings.name = nameInput.value.trim().slice(0, 16);
      saveSettings(this.settings);
      this.conn?.send({ t: 'join', playerId: this.me, name: this.settings.name || 'Player' });
    });

    const level = $<HTMLInputElement>('#online-level');
    level.addEventListener('input', () => {
      this.settings.level = Number(level.value);
      saveSettings(this.settings);
      $('#online-level-out').textContent = level.value;
    });
    level.addEventListener('change', () => this.sendSetup());

    for (const b of document.querySelectorAll<HTMLButtonElement>('#online-speed button')) {
      b.addEventListener('click', () => {
        this.settings.speed = b.dataset.value as Speed;
        saveSettings(this.settings);
        this.sendSetup();
        this.render();
      });
    }
    for (const b of document.querySelectorAll<HTMLButtonElement>('#online-fast button')) {
      b.addEventListener('click', () => this.conn?.send({ t: 'settings', fastGarbage: b.dataset.value === 'on' }));
    }
    for (const b of document.querySelectorAll<HTMLButtonElement>('#online-outbreak button')) {
      b.addEventListener('click', () => this.conn?.send({ t: 'settings', outbreak: b.dataset.value === 'on' }));
    }
    $('#ready-btn').addEventListener('click', () => this.conn?.send({ t: 'ready', ready: !this.mine()?.ready }));
    $('#start-online').addEventListener('click', () => this.conn?.send({ t: 'start' }));
    $('#leave-room').addEventListener('click', () => this.leave());
  }

  private render(): void {
    if ($('#lobby').classList.contains('hidden')) return;
    const lobby = this.lobby;
    const me = this.mine();
    const isHost = !!lobby && lobby.hostId === this.me;

    // Your own setup
    const level = $<HTMLInputElement>('#online-level');
    level.value = String(this.settings.level);
    $('#online-level-out').textContent = String(this.settings.level);
    for (const b of document.querySelectorAll<HTMLButtonElement>('#online-speed button')) {
      b.classList.toggle('on', b.dataset.value === this.settings.speed);
    }

    // Room setting: everyone sees it, only the host can change it
    const fast = lobby?.settings.fastGarbage ?? false;
    for (const b of document.querySelectorAll<HTMLButtonElement>('#online-fast button')) {
      b.classList.toggle('on', (b.dataset.value === 'on') === fast);
      b.disabled = !isHost;
    }
    const outbreak = lobby?.settings.outbreak ?? false;
    for (const b of document.querySelectorAll<HTMLButtonElement>('#online-outbreak button')) {
      b.classList.toggle('on', (b.dataset.value === 'on') === outbreak);
      b.disabled = !isHost;
    }
    $('#fast-note').textContent = isHost ? '(you decide, as host)' : '(host decides)';

    // Players
    const list = $('#lobby-players');
    const items: HTMLElement[] = (lobby?.players ?? []).map(p => {
      const li = document.createElement('li');
      const who = document.createElement('span');
      who.className = 'who';
      who.textContent = p.name + (p.id === this.me ? ' (you)' : '');
      const meta = document.createElement('span');
      meta.className = 'meta';
      meta.textContent = `Lv ${p.level} · ${SPEED_LABEL[p.speed]}`;
      li.append(who, meta);
      const tag = (text: string, cls: string) => {
        const t = document.createElement('span');
        t.className = `tag ${cls}`;
        t.textContent = text;
        li.append(t);
      };
      if (p.id === lobby!.hostId) tag('HOST', 'host');
      if (!p.connected) tag('AWAY', 'away');
      else if (p.ready) tag('READY', 'ready');
      return li;
    });
    if (items.length < MAX_PLAYERS) {
      const li = document.createElement('li');
      li.className = 'empty';
      li.textContent = items.length < MIN_PLAYERS
        ? 'Waiting for a friend… (send them the link)'
        : `Room for ${MAX_PLAYERS - items.length} more (up to ${MAX_PLAYERS} players)`;
      items.push(li);
    }
    list.replaceChildren(...items);

    // Buttons
    const ready = $<HTMLButtonElement>('#ready-btn');
    ready.textContent = me?.ready ? 'Ready ✓' : 'Ready';
    ready.classList.toggle('on', !!me?.ready);
    ready.disabled = !me;
    const start = $<HTMLButtonElement>('#start-online');
    start.classList.toggle('hidden', !isHost);
    const enough = (lobby?.players.length ?? 0) >= MIN_PLAYERS;
    const allReady = enough && lobby!.players.every(p => p.ready && p.connected);
    start.disabled = !allReady;
    ready.parentElement!.style.gridTemplateColumns = isHost ? '1fr 1fr' : '1fr';

    // Status line
    const slow = performance.now() - this.connectingSince > SLOW_CONNECT_MS;
    $('#lobby-status').textContent =
      (this.status === 'connecting' || this.status === 'reconnecting') && slow
        ? "Can't reach the multiplayer server. Still trying… (Developing locally? Check that `npm run dev:server` is running and you're on the right port.)" :
      this.status === 'connecting' ? 'Connecting…' :
      this.status === 'reconnecting' ? 'Connection lost, reconnecting…' :
      this.status === 'closed' ? 'Disconnected.' :
      lobby?.phase === 'playing' ? "A match is in progress. You'll join in at the next round." :
      !enough ? `Share the link or the room code with friends (${MIN_PLAYERS}–${MAX_PLAYERS} players).` :
      !allReady ? 'Waiting for everyone to be ready.' :
      isHost ? 'Everyone is ready. Press Start!' : 'Everyone is ready. Waiting for the host to start.';
  }
}
