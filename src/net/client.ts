import type { ClientMessage, ServerMessage } from './protocol';

export type ConnectionStatus = 'connecting' | 'open' | 'reconnecting' | 'closed';

/** Close codes from the server that mean "don't bother reconnecting" (room full, game in progress). */
const FATAL_CLOSE_CODES = new Set([4000]);

/**
 * WebSocket to one room on the relay. Joins on every (re)connect and retries with
 * backoff if the connection drops, so a network blip doesn't lose your seat.
 */
export class RoomConnection {
  private ws: WebSocket | null = null;
  private retries = 0;
  private retryTimer: ReturnType<typeof setTimeout> | undefined;
  private closedByUs = false;

  constructor(
    readonly code: string,
    private readonly joinMessage: () => ClientMessage,
    private readonly onMessage: (msg: ServerMessage) => void,
    private readonly onStatus: (status: ConnectionStatus) => void,
  ) {}

  connect(): void {
    this.closedByUs = false;
    this.open('connecting');
  }

  send(msg: ClientMessage): void {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(msg));
  }

  close(): void {
    this.closedByUs = true;
    clearTimeout(this.retryTimer);
    this.ws?.close(1000, 'left');
    this.ws = null;
    this.onStatus('closed');
  }

  private open(status: ConnectionStatus): void {
    this.onStatus(status);
    const scheme = location.protocol === 'https:' ? 'wss' : 'ws';
    const ws = new WebSocket(`${scheme}://${location.host}/parties/room/${this.code}`);
    this.ws = ws;
    ws.onopen = () => {
      this.retries = 0;
      this.onStatus('open');
      ws.send(JSON.stringify(this.joinMessage()));
    };
    ws.onmessage = e => {
      try {
        this.onMessage(JSON.parse(e.data) as ServerMessage);
      } catch { /* ignore malformed */ }
    };
    ws.onclose = e => {
      if (this.ws !== ws) return; // an older socket
      this.ws = null;
      if (this.closedByUs || FATAL_CLOSE_CODES.has(e.code)) {
        this.onStatus('closed');
        return;
      }
      const delay = Math.min(5000, 500 * 2 ** this.retries++);
      this.retryTimer = setTimeout(() => this.open('reconnecting'), delay);
      this.onStatus('reconnecting');
    };
  }
}

let cachedId: string | null = null;

/** This tab's player id. Per tab (sessionStorage), so two tabs on one computer are two players. */
export function playerId(): string {
  if (cachedId) return cachedId;
  const KEY = 'drzerg.playerId';
  try {
    cachedId = sessionStorage.getItem(KEY);
  } catch { /* storage unavailable */ }
  if (!cachedId) {
    cachedId = Array.from(crypto.getRandomValues(new Uint8Array(12)), b => b.toString(16).padStart(2, '0')).join('');
    try {
      sessionStorage.setItem(KEY, cachedId);
    } catch { /* ignore */ }
  }
  return cachedId;
}
