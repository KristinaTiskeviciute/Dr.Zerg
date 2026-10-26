import { ClientMessage, LobbyPlayer, RtcSignal } from './protocol';

/** Used when the server can't be asked (or has no TURN relay set up). */
const FALLBACK_ICE: RTCIceServer[] = [{ urls: ['stun:stun.cloudflare.com:3478', 'stun:stun.l.google.com:19302'] }];
/** A connection that failed is tried again after this long. */
const RETRY_MS = 3000;
/** Mic level (0–1) above which someone counts as talking. */
const SPEAKING_LEVEL = 0.06;

export type VoiceStatus = 'off' | 'joining' | 'on';
export type PeerState = 'connecting' | 'connected' | 'failed';

/** How loud a stream is right now (for the "talking" dot). */
interface Meter {
  level(): number;
  stop(): void;
}

interface Peer {
  pc: RTCPeerConnection;
  audio: HTMLAudioElement;
  /** Address candidates that arrived before the other side's description. */
  pending: RTCIceCandidateInit[];
  meter: Meter | null;
}

/**
 * Voice chat for an online room: one direct audio connection (WebRTC) to every other player
 * in voice, set up through the room server. The player with the smaller id makes the call, so
 * two players never call each other at once.
 */
export class VoiceChat {
  status: VoiceStatus = 'off';
  muted = false;
  /** Joined without a microphone (no permission, or none plugged in): you can still listen. */
  listenOnly = false;
  /** The server has a TURN relay set up (for players who can't connect directly). */
  relay = false;
  private mic: MediaStream | null = null;
  private ctx: AudioContext | null = null;
  private myMeter: Meter | null = null;
  private ice: RTCIceServer[] = FALLBACK_ICE;
  private peers = new Map<string, Peer>();
  /** The other players in voice (from the latest lobby state). */
  private others = new Set<string>();
  private retries = new Map<string, ReturnType<typeof setTimeout>>();

  constructor(
    private readonly me: string,
    private readonly send: (msg: ClientMessage) => void,
    private readonly onChange: () => void,
  ) {}

  async join(): Promise<void> {
    if (this.status !== 'off') return;
    this.status = 'joining';
    this.onChange();
    this.ctx = new AudioContext(); // created on the click, so the browser lets it play
    const [ice, mic] = await Promise.all([
      fetchIce(),
      navigator.mediaDevices?.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } })
        .catch(err => { console.warn(`[voice] no microphone: ${err}`); return null; }) ?? Promise.resolve(null),
    ]);
    if (this.status !== 'joining') { // left while waiting
      mic?.getTracks().forEach(t => t.stop());
      return;
    }
    this.ice = ice.iceServers;
    this.relay = ice.relay;
    this.mic = mic;
    this.listenOnly = !mic;
    this.muted = false;
    if (mic) this.myMeter = meter(this.ctx, mic);
    this.status = 'on';
    this.send({ t: 'voice', on: true });
    this.connectAll();
    this.onChange();
  }

  leave(): void {
    if (this.status === 'off') return;
    this.send({ t: 'voice', on: false });
    for (const id of [...this.peers.keys()]) this.closePeer(id);
    for (const t of this.retries.values()) clearTimeout(t);
    this.retries.clear();
    this.mic?.getTracks().forEach(t => t.stop());
    this.mic = null;
    this.myMeter?.stop();
    this.myMeter = null;
    void this.ctx?.close();
    this.ctx = null;
    this.status = 'off';
    this.onChange();
  }

  toggleMute(): void {
    if (!this.mic) return;
    this.muted = !this.muted;
    for (const t of this.mic.getAudioTracks()) t.enabled = !this.muted;
    this.onChange();
  }

  /** A lobby update: who's in voice now. */
  sync(players: LobbyPlayer[]): void {
    const mine = players.find(p => p.id === this.me);
    // The server forgets your voice flag if your connection blipped; tell it again.
    if (this.status === 'on' && mine && !mine.voice) this.send({ t: 'voice', on: true });
    this.others = new Set(players.filter(p => p.id !== this.me && p.voice && p.connected).map(p => p.id));
    for (const id of [...this.peers.keys()]) if (!this.others.has(id)) this.closePeer(id);
    this.connectAll();
    this.onChange();
  }

  /** Voice setup from another player. */
  async onSignal(from: string, data: RtcSignal): Promise<void> {
    if (this.status !== 'on') return;
    try {
      if ('sdp' in data) {
        if (data.sdp.type === 'offer') await this.answer(from, data.sdp);
        else {
          const peer = this.peers.get(from);
          if (!peer || peer.pc.signalingState !== 'have-local-offer') return;
          await peer.pc.setRemoteDescription(data.sdp);
          await this.flush(peer);
        }
      } else {
        const peer = this.peers.get(from);
        if (!peer) return;
        if (peer.pc.remoteDescription) await peer.pc.addIceCandidate(data.candidate).catch(() => {});
        else peer.pending.push(data.candidate);
      }
    } catch (err) {
      console.warn(`[voice] setup with ${from} failed: ${err}`);
    }
  }

  /** Connection state with another player in voice. */
  peerState(id: string): PeerState {
    const pc = this.peers.get(id)?.pc;
    if (!pc) return 'connecting';
    if (pc.connectionState === 'connected') return 'connected';
    return pc.connectionState === 'failed' ? 'failed' : 'connecting';
  }

  /** Is this player (or you) talking right now? */
  speaking(id: string): boolean {
    if (id === this.me) return !this.muted && (this.myMeter?.level() ?? 0) > SPEAKING_LEVEL;
    return (this.peers.get(id)?.meter?.level() ?? 0) > SPEAKING_LEVEL;
  }

  private connectAll(): void {
    if (this.status !== 'on') return;
    for (const id of this.others) if (!this.peers.has(id) && this.me < id) void this.call(id);
  }

  private async call(id: string): Promise<void> {
    const peer = this.newPeer(id);
    const track = this.mic?.getAudioTracks()[0];
    peer.pc.addTransceiver(track ?? 'audio', { direction: 'sendrecv', streams: this.mic ? [this.mic] : [] });
    try {
      await peer.pc.setLocalDescription();
      this.sendSdp(id, peer.pc.localDescription!);
    } catch (err) {
      console.warn(`[voice] calling ${id} failed: ${err}`);
    }
  }

  private async answer(from: string, offer: RTCSessionDescriptionInit): Promise<void> {
    this.closePeer(from); // a fresh call replaces an old one
    const peer = this.newPeer(from);
    await peer.pc.setRemoteDescription(offer);
    const transceiver = peer.pc.getTransceivers()[0];
    const track = this.mic?.getAudioTracks()[0];
    if (transceiver) {
      if (track && this.mic) {
        await transceiver.sender.replaceTrack(track);
        transceiver.sender.setStreams?.(this.mic);
      }
      transceiver.direction = 'sendrecv';
    }
    await peer.pc.setLocalDescription();
    this.sendSdp(from, peer.pc.localDescription!);
    await this.flush(peer);
  }

  private sendSdp(to: string, d: RTCSessionDescription): void {
    if (d.type === 'offer' || d.type === 'answer') this.send({ t: 'rtc', to, data: { sdp: { type: d.type, sdp: d.sdp } } });
  }

  private async flush(peer: Peer): Promise<void> {
    const pending = peer.pending.splice(0);
    for (const c of pending) await peer.pc.addIceCandidate(c).catch(() => {});
  }

  private newPeer(id: string): Peer {
    const pc = new RTCPeerConnection({ iceServers: this.ice });
    const audio = new Audio();
    audio.autoplay = true;
    const peer: Peer = { pc, audio, pending: [], meter: null };
    pc.onicecandidate = e => {
      if (!e.candidate) return;
      const c = e.candidate.toJSON();
      this.send({
        t: 'rtc', to: id,
        data: { candidate: { candidate: c.candidate ?? '', sdpMid: c.sdpMid ?? null, sdpMLineIndex: c.sdpMLineIndex ?? null, usernameFragment: c.usernameFragment ?? null } },
      });
    };
    pc.ontrack = e => {
      const stream = e.streams[0] ?? new MediaStream([e.track]);
      audio.srcObject = stream;
      audio.play().catch(err => console.warn(`[voice] can't play audio: ${err}`));
      peer.meter?.stop();
      if (this.ctx) peer.meter = meter(this.ctx, stream);
    };
    pc.onconnectionstatechange = () => {
      if (pc.connectionState === 'failed') {
        console.warn(`[voice] connection to ${id} failed${this.relay ? '' : ' (no TURN relay set up)'}`);
        // The caller tries again in a moment; the other side waits for that call.
        if (this.me < id && !this.retries.has(id)) {
          this.retries.set(id, setTimeout(() => {
            this.retries.delete(id);
            if (this.peers.get(id)?.pc === pc) this.closePeer(id);
            this.connectAll();
          }, RETRY_MS));
        }
      }
      this.onChange();
    };
    this.peers.set(id, peer);
    return peer;
  }

  private closePeer(id: string): void {
    const peer = this.peers.get(id);
    if (!peer) return;
    this.peers.delete(id);
    peer.pc.onconnectionstatechange = null;
    peer.pc.close();
    peer.audio.srcObject = null;
    peer.meter?.stop();
  }
}

async function fetchIce(): Promise<{ iceServers: RTCIceServer[]; relay: boolean }> {
  try {
    const res = await fetch('/api/ice');
    if (res.ok) return await res.json();
  } catch { /* fall back to STUN only */ }
  return { iceServers: FALLBACK_ICE, relay: false };
}

function meter(ctx: AudioContext, stream: MediaStream): Meter {
  const source = ctx.createMediaStreamSource(stream);
  const analyser = ctx.createAnalyser();
  analyser.fftSize = 512;
  source.connect(analyser);
  const buf = new Uint8Array(analyser.fftSize);
  return {
    level() {
      analyser.getByteTimeDomainData(buf);
      let peak = 0;
      for (const v of buf) peak = Math.max(peak, Math.abs(v - 128));
      return peak / 128;
    },
    stop() {
      source.disconnect();
    },
  };
}
