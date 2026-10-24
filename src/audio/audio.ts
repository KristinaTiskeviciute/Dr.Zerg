import { JINGLES, SFX, SfxName, SONG_BPM, SONG_INSTRUMENTS, SONG_PATTERNS, SONG_SEQUENCE } from './sounds';
import { buildSamples, ZZFX_SAMPLE_RATE } from './zzfx';
import { zzfxM } from './zzfxm';

const STORAGE_KEY = 'drzerg.audio';
const SFX_VOLUME = 0.8;
const MUSIC_VOLUME = 0.35;

/**
 * Plays sound effects and the music loop. Browsers only allow audio after a user
 * gesture, so nothing is created until unlock() is called from a key press or click.
 */
class AudioManager {
  muted = false;
  musicOn = true;

  private ctx: AudioContext | null = null;
  private master!: GainNode;
  private sfxGain!: GainNode;
  private musicGain!: GainNode;
  private buffers = new Map<SfxName, AudioBuffer>();
  private song: AudioBuffer | null = null;
  private musicSource: AudioBufferSourceNode | null = null;
  private wantMusic = false;
  private musicPaused = false;
  private listeners: (() => void)[] = [];

  constructor() {
    try {
      const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? 'null');
      if (saved) {
        this.muted = !!saved.muted;
        this.musicOn = saved.musicOn !== false;
      }
    } catch { /* storage unavailable */ }
  }

  /** Call from a user gesture. Safe to call repeatedly. */
  unlock(): void {
    if (!this.ctx) {
      this.ctx = new AudioContext();
      this.master = this.gain(this.muted ? 0 : 1, this.ctx.destination);
      this.sfxGain = this.gain(SFX_VOLUME, this.master);
      this.musicGain = this.gain(MUSIC_VOLUME, this.master);
      for (const name of Object.keys(SFX) as SfxName[]) {
        const params = [...SFX[name]];
        params[1] = 0; // no built-in randomness; we vary pitch at play time instead
        this.buffers.set(name, this.toBuffer([buildSamples(...params)]));
      }
      // Rendering the song takes ~200 ms; do it now (usually on the menu) so starting a round doesn't stutter.
      setTimeout(() => this.renderSong(), 0);
    }
    if (this.ctx.state === 'suspended') void this.ctx.resume();
    if (this.wantMusic && !this.musicSource) this.startMusicSource();
  }

  play(name: SfxName, semitones = 0, jitter = 0.03): void {
    this.playAt(name, semitones + (Math.random() * 2 - 1) * jitter * 12, 0);
  }

  jingle(name: keyof typeof JINGLES): void {
    const [sound, notes, step] = JINGLES[name];
    notes.forEach((semi, i) => this.playAt(sound, semi, i * step));
  }

  /** Start the music loop from the beginning (for a new round). */
  startMusic(): void {
    this.wantMusic = true;
    this.musicPaused = false;
    this.stopMusicSource();
    this.startMusicSource();
  }

  stopMusic(): void {
    this.wantMusic = false;
    this.stopMusicSource();
  }

  setMusicPaused(paused: boolean): void {
    this.musicPaused = paused;
    this.applyMusicVolume();
  }

  toggleMute(): void {
    this.muted = !this.muted;
    if (this.ctx) this.master.gain.setTargetAtTime(this.muted ? 0 : 1, this.ctx.currentTime, 0.02);
    this.changed();
  }

  toggleMusic(): void {
    this.musicOn = !this.musicOn;
    this.applyMusicVolume();
    if (this.musicOn && this.wantMusic && !this.musicSource) this.startMusicSource();
    this.changed();
  }

  onChange(fn: () => void): void {
    this.listeners.push(fn);
  }

  // --- internals ---

  private playAt(name: SfxName, semitones: number, delaySec: number): void {
    const buffer = this.buffers.get(name);
    if (!this.ctx || !buffer || this.muted) return;
    const src = this.ctx.createBufferSource();
    src.buffer = buffer;
    src.playbackRate.value = 2 ** (semitones / 12);
    src.connect(this.sfxGain);
    src.start(this.ctx.currentTime + delaySec);
  }

  private startMusicSource(): void {
    if (!this.ctx || !this.musicOn || this.musicSource) return;
    const src = this.ctx.createBufferSource();
    src.buffer = this.renderSong();
    src.loop = true;
    src.connect(this.musicGain);
    src.start();
    this.musicSource = src;
    this.applyMusicVolume();
  }

  private renderSong(): AudioBuffer {
    if (!this.song) {
      const [left, right] = zzfxM(SONG_INSTRUMENTS, SONG_PATTERNS, SONG_SEQUENCE, SONG_BPM);
      const clean = (c: number[]) => Float32Array.from(c, v => v || 0); // fill any gaps with silence
      this.song = this.toBuffer([clean(left), clean(right)]);
    }
    return this.song;
  }

  private stopMusicSource(): void {
    this.musicSource?.stop();
    this.musicSource?.disconnect();
    this.musicSource = null;
  }

  private applyMusicVolume(): void {
    if (!this.ctx) return;
    const v = this.musicOn && !this.musicPaused ? MUSIC_VOLUME : 0;
    this.musicGain.gain.setTargetAtTime(v, this.ctx.currentTime, 0.05);
  }

  private gain(value: number, to: AudioNode): GainNode {
    const g = this.ctx!.createGain();
    g.gain.value = value;
    g.connect(to);
    return g;
  }

  private toBuffer(channels: ArrayLike<number>[]): AudioBuffer {
    const length = Math.max(1, channels[0].length);
    const buf = this.ctx!.createBuffer(channels.length, length, ZZFX_SAMPLE_RATE);
    channels.forEach((c, i) => buf.getChannelData(i).set(c));
    return buf;
  }

  private changed(): void {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify({ muted: this.muted, musicOn: this.musicOn }));
    } catch { /* storage unavailable */ }
    for (const fn of this.listeners) fn();
  }
}

export const audio = new AudioManager();
