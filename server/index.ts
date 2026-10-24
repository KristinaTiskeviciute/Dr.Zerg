// The relay server: one Room (Durable Object) per room code. It holds the lobby state and
// passes messages along. It never simulates the game.

import { type Connection, routePartykitRequest, Server, type WSMessage } from 'partyserver';
import { RECONNECT_GRACE_S } from '../src/config';
import { normalizeRoomCode, parseClientMessage, type ServerMessage } from '../src/net/protocol';
import { Lobby, type Result } from './lobby';

interface ConnState {
  playerId: string;
}

export class Room extends Server<Env> {
  private lobby!: Lobby;
  /** Seats of disconnected players are freed after the reconnect grace period. */
  private removals = new Map<string, ReturnType<typeof setTimeout>>();

  onStart(): void {
    this.lobby = new Lobby(this.name);
  }

  onMessage(conn: Connection<ConnState>, raw: WSMessage): void {
    if (typeof raw !== 'string') return;
    const msg = parseClientMessage(raw);
    if (!msg) return this.send(conn, { t: 'error', code: 'badMessage', message: 'Unrecognized message.' });

    if (msg.t === 'join') {
      const res = this.lobby.join(msg.playerId, msg.name);
      if (!res.ok) {
        this.send(conn, { t: 'error', code: res.code, message: res.message });
        conn.close(4000, res.code);
        return;
      }
      // Same player connecting again (e.g. after a network blip): drop the stale socket.
      for (const other of this.getConnections<ConnState>()) {
        if (other.id !== conn.id && other.state?.playerId === msg.playerId) other.close(4001, 'replaced');
      }
      conn.setState({ playerId: msg.playerId });
      this.cancelRemoval(msg.playerId);
      return this.broadcastLobby();
    }

    const id = conn.state?.playerId;
    if (!id) return this.send(conn, { t: 'error', code: 'notAllowed', message: 'Join the room first.' });

    let res: Result<unknown> = { ok: true, value: undefined };
    switch (msg.t) {
      case 'setup': res = this.lobby.setup(id, msg.level, msg.speed); break;
      case 'ready': res = this.lobby.setReady(id, msg.ready); break;
      case 'settings': res = this.lobby.setSettings(id, msg.fastGarbage); break;
      case 'backToLobby': this.lobby.backToLobby(); break;
      case 'start': {
        const started = this.lobby.start(id, crypto.getRandomValues(new Uint32Array(1))[0]);
        if (started.ok) this.broadcastJson({ t: 'start', ...started.value });
        res = started;
        break;
      }
    }
    if (!res.ok) this.send(conn, { t: 'error', code: res.code, message: res.message });
    else this.broadcastLobby();
  }

  onClose(conn: Connection<ConnState>): void {
    const id = conn.state?.playerId;
    if (!id) return;
    // Replaced by a newer connection for the same player? Then they haven't left.
    for (const other of this.getConnections<ConnState>()) {
      if (other.id !== conn.id && other.state?.playerId === id) return;
    }
    this.lobby.disconnect(id);
    this.broadcastLobby();
    this.cancelRemoval(id);
    this.removals.set(id, setTimeout(() => {
      this.removals.delete(id);
      if (this.lobby.isConnected(id)) return;
      this.lobby.remove(id);
      this.broadcastLobby();
    }, RECONNECT_GRACE_S * 1000));
  }

  private cancelRemoval(id: string): void {
    const timer = this.removals.get(id);
    if (timer !== undefined) clearTimeout(timer);
    this.removals.delete(id);
  }

  private broadcastLobby(): void {
    this.broadcastJson({ t: 'lobby', lobby: this.lobby.state });
  }

  private broadcastJson(msg: ServerMessage): void {
    this.broadcast(JSON.stringify(msg));
  }

  private send(conn: Connection, msg: ServerMessage): void {
    conn.send(JSON.stringify(msg));
  }
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const routed = await routePartykitRequest(request, env, {
      // Rooms live in eastern North America: roughly halfway between Norway and California.
      locationHint: 'enam',
      onBeforeConnect: (_req, { name }) =>
        normalizeRoomCode(name) === name ? undefined : new Response('Unknown room', { status: 404 }),
    });
    return routed ?? env.ASSETS.fetch(request);
  },
} satisfies ExportedHandler<Env>;
