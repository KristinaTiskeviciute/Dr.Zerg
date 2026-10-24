import { describe, expect, it } from 'vitest';
import { makeRoomCode, normalizeRoomCode, parseClientMessage } from '../src/net/protocol';
import { Lobby } from './lobby';

function twoReady(): Lobby {
  const l = new Lobby('ABCD');
  l.join('alice-1', 'Alice');
  l.join('bob-123', 'Bob');
  l.setReady('alice-1', true);
  l.setReady('bob-123', true);
  return l;
}

describe('Lobby', () => {
  it('makes the first player host and fills two seats', () => {
    const l = new Lobby('ABCD');
    expect(l.join('alice-1', 'Alice').ok).toBe(true);
    expect(l.join('bob-123', 'Bob').ok).toBe(true);
    expect(l.state.hostId).toBe('alice-1');
    expect(l.state.players.map(p => p.name)).toEqual(['Alice', 'Bob']);
  });

  it('turns away a third player', () => {
    const l = twoReady();
    const r = l.join('carol-1', 'Carol');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe('full');
  });

  it('lets a player reconnect into their own seat', () => {
    const l = twoReady();
    l.disconnect('bob-123');
    expect(l.state.players[1].connected).toBe(false);
    expect(l.join('bob-123', 'Bob').ok).toBe(true);
    expect(l.state.players[1].connected).toBe(true);
    expect(l.state.players).toHaveLength(2);
  });

  it('passes host to the next player when the host leaves', () => {
    const l = twoReady();
    l.remove('alice-1');
    expect(l.state.hostId).toBe('bob-123');
  });

  it('only the host can change room settings', () => {
    const l = twoReady();
    expect(l.setSettings('bob-123', true).ok).toBe(false);
    expect(l.setSettings('alice-1', true).ok).toBe(true);
    expect(l.state.settings.fastGarbage).toBe(true);
  });

  it('starts only when the host asks and both players are here and ready', () => {
    const l = new Lobby('ABCD');
    l.join('alice-1', 'Alice');
    expect(l.start('alice-1', 1).ok).toBe(false); // alone
    l.join('bob-123', 'Bob');
    l.setReady('alice-1', true);
    expect(l.start('alice-1', 1).ok).toBe(false); // Bob not ready
    l.setReady('bob-123', true);
    expect(l.start('bob-123', 1).ok).toBe(false); // not host
    const r = l.start('alice-1', 42);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.seed).toBe(42);
      expect(r.value.players.map(p => p.id)).toEqual(['alice-1', 'bob-123']);
      expect(r.value.startInMs).toBeGreaterThan(0);
    }
    expect(l.state.phase).toBe('playing');
  });

  it('locks settings, setups and new joins during a match', () => {
    const l = twoReady();
    l.start('alice-1', 1);
    expect(l.setSettings('alice-1', true).ok).toBe(false);
    expect(l.setup('bob-123', 9, 'high').ok).toBe(false);
    l.disconnect('bob-123');
    l.remove('bob-123');
    expect(l.join('carol-1', 'Carol').ok).toBe(false);
  });

  it('back to lobby keeps settings and clears ready flags', () => {
    const l = twoReady();
    l.setSettings('alice-1', true);
    l.start('alice-1', 1);
    l.backToLobby();
    expect(l.state.phase).toBe('lobby');
    expect(l.state.settings.fastGarbage).toBe(true);
    expect(l.state.players.every(p => !p.ready)).toBe(true);
  });

  it('a disconnected player is not ready (so a match cannot start without them)', () => {
    const l = twoReady();
    l.disconnect('bob-123');
    expect(l.canStart).toBe(false);
  });
});

describe('protocol', () => {
  it('accepts valid messages and rejects junk', () => {
    expect(parseClientMessage('{"t":"join","playerId":"abc123","name":"  Kris  "}')).toEqual({ t: 'join', playerId: 'abc123', name: 'Kris' });
    expect(parseClientMessage('{"t":"setup","level":21,"speed":"med"}')).toBeNull();
    expect(parseClientMessage('{"t":"setup","level":7,"speed":"warp"}')).toBeNull();
    expect(parseClientMessage('not json')).toBeNull();
    expect(parseClientMessage('{"t":"hack"}')).toBeNull();
  });

  it('caps and cleans names', () => {
    const m = parseClientMessage(JSON.stringify({ t: 'join', playerId: 'abc123', name: 'x'.repeat(40) }));
    expect(m && m.t === 'join' && m.name.length).toBe(16);
  });

  it('makes readable 4-letter room codes and normalizes typed ones', () => {
    for (let i = 0; i < 50; i++) expect(makeRoomCode()).toMatch(/^[A-HJKMNP-Z]{4}$/);
    expect(normalizeRoomCode(' abcd ')).toBe('ABCD');
    expect(normalizeRoomCode('AB1D')).toBeNull();
    expect(normalizeRoomCode('ABCDE')).toBeNull();
  });
});
