// The relay server: one Room (Durable Object) per room code. It holds the lobby state and
// passes messages along. It never simulates the game.

import { type Connection, routePartykitRequest, Server, type WSMessage } from 'partyserver';
import { RECONNECT_GRACE_S } from '../src/config';
import {
  normalizeRoomCode, parseClientMessage, RESUME_COUNTDOWN_MS, type RoundResult, type ServerMessage,
} from '../src/net/protocol';
import { RoomChat } from './chat';
import { Lobby, type Report, type Result } from './lobby';

interface ConnState {
  playerId: string;
}

const randomSeed = () => crypto.getRandomValues(new Uint32Array(1))[0];

export class Room extends Server<Env> {
  private lobby!: Lobby;
  private chat = new RoomChat();
  /** Seats of disconnected players are freed (or the match forfeited) after the grace period. */
  private removals = new Map<string, ReturnType<typeof setTimeout>>();
  private nextRoundTimer: ReturnType<typeof setTimeout> | undefined;

  onStart(): void {
    this.lobby = new Lobby(this.name);
  }

  onMessage(conn: Connection<ConnState>, raw: WSMessage): void {
    if (typeof raw !== 'string') return;
    const msg = parseClientMessage(raw);
    if (!msg) return this.send(conn, { t: 'error', code: 'badMessage', message: 'Unrecognized message.' });

    if (msg.t === 'join') return this.onJoin(conn, msg.playerId, msg.name);

    const id = conn.state?.playerId;
    if (!id) return this.send(conn, { t: 'error', code: 'notAllowed', message: 'Join the room first.' });

    // A CPU's or couch guest's board, garbage or result, from the browser that plays it.
    let who = id;
    if ((msg.t === 'board' || msg.t === 'garbage' || msg.t === 'result') && msg.as) {
      if (!this.lobby.playsFor(id, msg.as)) return;
      who = msg.as;
    }

    // In-match messages: relay to the other player, or decide the round. Chat goes to everyone.
    switch (msg.t) {
      case 'chat':
        if (this.chat.allow(id, Date.now())) {
          const line = { from: id, name: this.lobby.nameOf(id), text: msg.text };
          this.chat.add(line);
          this.broadcastJson({ t: 'chat', ...line });
        }
        return;
      case 'emote':
        if (this.chat.allow(id, Date.now())) this.broadcastJson({ t: 'emote', from: id, name: this.lobby.nameOf(id), e: msg.e });
        return;
      case 'rtc': {
        // Voice setup: pass it to that one player.
        if (!this.lobby.isHere(msg.to) || msg.to === id) return;
        const out: ServerMessage = { t: 'rtc', from: id, data: msg.data };
        for (const c of this.getConnections<ConnState>()) if (c.state?.playerId === msg.to) this.send(c, out);
        return;
      }
      case 'board':
        if (this.lobby.inMatch) this.broadcastJson({ t: 'board', from: who, snap: msg.snap }, [conn.id]);
        return;
      case 'garbage': {
        // The server picks the targets, so every player agrees who got hit. Garbage for a CPU or a
        // couch guest goes to the browser that plays it.
        for (const target of this.lobby.garbageTargets(who, msg.firstColors)) {
          const runner = this.lobby.runnerOf(target);
          const out: ServerMessage = { t: 'garbage', from: who, colors: msg.colors, ...(runner && { to: target }) };
          for (const c of this.getConnections<ConnState>()) {
            if (c.state?.playerId === (runner ?? target)) this.send(c, out);
          }
        }
        return;
      }
      case 'pause':
        if (this.lobby.inMatch) {
          this.broadcastJson({ t: 'pause', paused: msg.paused, by: this.lobby.nameOf(id), resumeInMs: msg.paused ? 0 : RESUME_COUNTDOWN_MS });
        }
        return;
      case 'result': {
        const r = this.lobby.result(who, msg.outcome);
        if (r) this.announce(r);
        return;
      }
    }

    // Lobby messages
    let res: Result<unknown> = { ok: true, value: undefined };
    switch (msg.t) {
      case 'setup': res = this.lobby.setup(id, msg.level, msg.speed); break;
      case 'ready': res = this.lobby.setReady(id, msg.ready); break;
      case 'voice': res = this.lobby.setVoice(id, msg.on); break;
      case 'addCpu': res = this.lobby.addCpu(id, `cpu-${crypto.randomUUID().slice(0, 8)}`); break;
      case 'cpu': res = this.lobby.setCpu(id, msg.id, msg); break;
      case 'removeCpu': res = this.lobby.removeCpu(id, msg.id); break;
      case 'addGuest': res = this.lobby.addGuest(id, msg.id, msg.name); break;
      case 'guest': res = this.lobby.setGuest(id, msg.id, msg); break;
      case 'removeGuest': res = this.lobby.removeGuest(id, msg.id); break;
      case 'settings': res = this.lobby.setSettings(id, { fastGarbage: msg.fastGarbage, outbreak: msg.outbreak }); break;
      case 'backToLobby':
        // After a match, or between rounds (then it ends the match for everyone); not mid-round.
        if (this.lobby.inMatch && !this.lobby.roundOver) {
          res = { ok: false, code: 'notAllowed', message: "Can't go back to the lobby during a round." };
          break;
        }
        if (this.lobby.inMatch) this.broadcastJson({ t: 'toLobby', id, by: this.lobby.nameOf(id) });
        this.clearNextRound();
        this.lobby.backToLobby();
        break;
      case 'start': {
        const started = this.lobby.start(id, randomSeed());
        if (started.ok) this.broadcastJson({ t: 'start', ...started.value });
        res = started;
        break;
      }
      case 'playAgain': {
        const again = this.lobby.playAgain(id, randomSeed());
        if (again.ok && again.value) this.broadcastJson({ t: 'start', ...again.value });
        res = again;
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
    if (this.lobby.inMatch) {
      this.broadcastJson({ t: 'away', id, name: this.lobby.nameOf(id), graceMs: RECONNECT_GRACE_S * 1000 });
    }
    this.broadcastLobby();
    this.cancelRemoval(id);
    this.removals.set(id, setTimeout(() => {
      this.removals.delete(id);
      if (this.lobby.isConnected(id)) return;
      // Gone for good: they're out of the match (with two players the other one wins); the seat is freed.
      // The CPUs their browser was playing are out of this round too; someone else plays them next round.
      // Their couch guests leave with them.
      for (const seat of [...this.lobby.cpusRunBy(id), ...this.lobby.guestsOf(id)]) {
        const rc = this.lobby.abandon(seat);
        if (rc) this.announce(rc);
      }
      const r = this.lobby.abandon(id);
      if (r) this.announce(r);
      this.lobby.remove(id);
      if (this.lobby.state.players.length === 0) this.chat.clear(); // a fresh start for the next group
      this.broadcastLobby();
    }, RECONNECT_GRACE_S * 1000));
  }

  private onJoin(conn: Connection<ConnState>, playerId: string, name: string): void {
    const wasAway = this.lobby.inMatch && this.lobby.state.players.some(p => p.id === playerId && !p.connected);
    const res = this.lobby.join(playerId, name);
    if (!res.ok) {
      this.send(conn, { t: 'error', code: res.code, message: res.message });
      conn.close(4000, res.code);
      return;
    }
    // Same player connecting again (e.g. after a network blip): drop the stale socket.
    for (const other of this.getConnections<ConnState>()) {
      if (other.id !== conn.id && other.state?.playerId === playerId) other.close(4001, 'replaced');
    }
    conn.setState({ playerId });
    this.cancelRemoval(playerId);
    this.send(conn, { t: 'chatLog', lines: this.chat.history });
    if (wasAway) {
      this.broadcastJson({ t: 'back', id: playerId, resumeInMs: RESUME_COUNTDOWN_MS });
      // If they were gone when the next round was due, start it now.
      if (this.lobby.roundOver && this.nextRoundTimer === undefined) this.scheduleNextRound(RESUME_COUNTDOWN_MS);
    }
    this.broadcastLobby();
  }

  /** Tell everyone who was knocked out, and the round result if it's decided. */
  private announce(r: Report): void {
    if (r.out) this.broadcastJson({ t: 'out', id: r.out.id, reason: r.out.reason });
    if (r.round) this.announceRound(r.round);
  }

  private announceRound(r: RoundResult): void {
    this.broadcastJson({ t: 'round', ...r });
    if (r.nextInMs !== null) this.scheduleNextRound(r.nextInMs);
    else this.clearNextRound();
    this.broadcastLobby();
  }

  private scheduleNextRound(delay: number): void {
    this.clearNextRound();
    this.nextRoundTimer = setTimeout(() => {
      this.nextRoundTimer = undefined;
      const info = this.lobby.nextRound(randomSeed());
      if (info) this.broadcastJson({ t: 'start', ...info });
    }, delay);
  }

  private clearNextRound(): void {
    if (this.nextRoundTimer !== undefined) clearTimeout(this.nextRoundTimer);
    this.nextRoundTimer = undefined;
  }

  private cancelRemoval(id: string): void {
    const timer = this.removals.get(id);
    if (timer !== undefined) clearTimeout(timer);
    this.removals.delete(id);
  }

  private broadcastLobby(): void {
    this.broadcastJson({ t: 'lobby', lobby: this.lobby.state });
  }

  private broadcastJson(msg: ServerMessage, exclude: string[] = []): void {
    this.broadcast(JSON.stringify(msg), exclude);
  }

  private send(conn: Connection, msg: ServerMessage): void {
    conn.send(JSON.stringify(msg));
  }
}

/** Optional Cloudflare TURN key (secrets), for voice when two players can't connect directly. */
interface TurnEnv {
  TURN_KEY_ID?: string;
  TURN_KEY_API_TOKEN?: string;
}

const STUN_ONLY: RTCIceServerJson[] = [{ urls: ['stun:stun.cloudflare.com:3478', 'stun:stun.l.google.com:19302'] }];
interface RTCIceServerJson { urls: string | string[]; username?: string; credential?: string }

/**
 * Network servers for voice chat. With a TURN key set up, fresh relay credentials (good for a
 * few hours); otherwise just STUN, which works whenever the two players can connect directly.
 */
async function iceServers(env: TurnEnv): Promise<Response> {
  let servers = STUN_ONLY;
  let relay = false;
  if (env.TURN_KEY_ID && env.TURN_KEY_API_TOKEN) {
    try {
      const res = await fetch(`https://rtc.live.cloudflare.com/v1/turn/keys/${env.TURN_KEY_ID}/credentials/generate-ice-servers`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${env.TURN_KEY_API_TOKEN}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ ttl: 6 * 60 * 60 }),
      });
      if (res.ok) {
        const body = await res.json() as { iceServers: RTCIceServerJson[] };
        // Browsers block port 53, so those addresses would only time out.
        servers = body.iceServers.map(s => ({ ...s, urls: [s.urls].flat().filter(u => !/:53(\?|$)/.test(u)) }));
        relay = true;
      } else {
        console.warn(`TURN credentials: ${res.status} ${await res.text()}`);
      }
    } catch (err) {
      console.warn(`TURN credentials failed: ${err}`);
    }
  }
  return Response.json({ iceServers: servers, relay }, { headers: { 'Cache-Control': 'no-store' } });
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    if (new URL(request.url).pathname === '/api/ice') return iceServers(env as Env & TurnEnv);
    const routed = await routePartykitRequest(request, env, {
      // Rooms live in eastern North America: roughly halfway between Norway and California.
      locationHint: 'enam',
      onBeforeConnect: (_req, { name }) =>
        normalizeRoomCode(name) === name ? undefined : new Response('Unknown room', { status: 404 }),
    });
    if (routed) return routed;
    // Local development: the game is served (and hot-reloaded) by Vite, so send browsers there
    // instead of serving a stale copy of the built game. Set by `npm run dev:server`.
    const devRedirect = (env as Env & { DEV_REDIRECT?: string }).DEV_REDIRECT;
    if (devRedirect) {
      const url = new URL(request.url);
      return Response.redirect(devRedirect + url.pathname + url.search, 302);
    }
    return env.ASSETS.fetch(request);
  },
} satisfies ExportedHandler<Env>;
