import { describe, expect, it } from 'vitest';
import { deriveSeed, Rng } from './rng';
import { PieceSequence, PILLS } from './pieces';

describe('Rng', () => {
  it('produces identical sequences for the same seed', () => {
    const a = new Rng(12345);
    const b = new Rng(12345);
    for (let i = 0; i < 1000; i++) expect(a.next()).toBe(b.next());
  });

  it('produces different sequences for different seeds', () => {
    const a = new Rng(1);
    const b = new Rng(2);
    const same = Array.from({ length: 20 }, () => a.next() === b.next()).filter(Boolean).length;
    expect(same).toBeLessThan(20);
  });

  it('int stays in range', () => {
    const r = new Rng(7);
    for (let i = 0; i < 1000; i++) {
      const n = r.int(9);
      expect(n).toBeGreaterThanOrEqual(0);
      expect(n).toBeLessThan(9);
    }
  });

  it('derived seeds differ per salt and are stable', () => {
    expect(deriveSeed(42, 'pieces')).toBe(deriveSeed(42, 'pieces'));
    expect(deriveSeed(42, 'pieces')).not.toBe(deriveSeed(42, 'germs'));
  });
});

describe('PieceSequence', () => {
  it('gives two players the same capsules for the same seed', () => {
    const a = new PieceSequence(99);
    const b = new PieceSequence(99);
    for (let i = 0; i < 200; i++) expect(a.idAt(i)).toBe(b.idAt(i));
  });

  it('is unaffected by the order pieces are looked up', () => {
    const a = new PieceSequence(5);
    const b = new PieceSequence(5);
    const late = b.idAt(50);
    for (let i = 0; i < 50; i++) a.idAt(i);
    expect(a.idAt(50)).toBe(late);
  });

  it('uses all 9 colorings, including single-color capsules', () => {
    const s = new PieceSequence(3);
    const seen = new Set<number>();
    for (let i = 0; i < 500; i++) seen.add(s.idAt(i));
    expect(seen.size).toBe(PILLS.length);
  });
});
