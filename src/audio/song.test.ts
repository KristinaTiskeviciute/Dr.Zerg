import { describe, expect, it } from 'vitest';
import { SFX, SONG_BPM, SONG_INSTRUMENTS, SONG_PATTERNS, SONG_SEQUENCE } from './sounds';
import { buildSamples, ZZFX_SAMPLE_RATE } from './zzfx';
import { zzfxM } from './zzfxm';

describe('audio data', () => {
  it('renders the song to a sane, loopable stereo buffer', () => {
    const [left, right] = zzfxM(SONG_INSTRUMENTS, SONG_PATTERNS, SONG_SEQUENCE, SONG_BPM);
    const rows = SONG_SEQUENCE.length * 32;
    const expectedSec = (rows * 60) / SONG_BPM / 4;
    expect(left.length / ZZFX_SAMPLE_RATE).toBeCloseTo(expectedSec, 0);
    expect(right.length).toBe(left.length);
    let peak = 0;
    for (let i = 0; i < left.length; i++) {
      const v = left[i] || 0;
      expect(Number.isFinite(v)).toBe(true);
      peak = Math.max(peak, Math.abs(v));
    }
    expect(peak).toBeGreaterThan(0.05);
    expect(peak).toBeLessThan(1.5);
  });

  it('every sound effect builds non-empty, finite samples', () => {
    for (const [name, params] of Object.entries(SFX)) {
      const s = buildSamples(...params);
      expect(s.length, name).toBeGreaterThan(100);
      expect(s.every(Number.isFinite), name).toBe(true);
    }
  });
});
