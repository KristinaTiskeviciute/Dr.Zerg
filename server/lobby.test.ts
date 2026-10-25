import { describe, expect, it } from 'vitest';
import { ROUNDS_TO_WIN } from '../src/config';
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
    const r = l.join('carol-1', 'Carol');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe('inProgress');
  });

  it('freeing a seat mid-match ends the match', () => {
    const l = twoReady();
    l.start('alice-1', 1);
    l.disconnect('bob-123');
    l.remove('bob-123');
    expect(l.state.phase).toBe('lobby');
    expect(l.inMatch).toBe(false);
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

describe('match', () => {
  function playing(): Lobby {
    const l = twoReady();
    l.start('alice-1', 1);
    return l;
  }

  it('clearing your bottle wins the round; topping out loses it', () => {
    const l = playing();
    const r1 = l.result('alice-1', 'cleared')!;
    expect(r1.winner).toBe('alice-1');
    expect(r1.wins).toEqual({ 'alice-1': 1, 'bob-123': 0 });
    expect(r1.matchOver).toBe(false);
    expect(r1.nextInMs).toBeGreaterThan(0);

    l.nextRound(2);
    const r2 = l.result('alice-1', 'toppedOut')!;
    expect(r2.winner).toBe('bob-123');
  });

  it('the first result decides the round; a late second one is ignored', () => {
    const l = playing();
    expect(l.result('bob-123', 'cleared')!.winner).toBe('bob-123');
    expect(l.result('alice-1', 'cleared')).toBeNull();
  });

  it('a forfeit (reload mid-round) gives the round to the other player', () => {
    const l = playing();
    expect(l.result('bob-123', 'forfeit')!.winner).toBe('alice-1');
  });

  it('next round only after a result, with a new round number and the score so far', () => {
    const l = playing();
    expect(l.nextRound(5)).toBeNull(); // round still going
    l.result('alice-1', 'cleared');
    const next = l.nextRound(5)!;
    expect(next.round).toBe(2);
    expect(next.seed).toBe(5);
    expect(next.wins['alice-1']).toBe(1);
    expect(l.nextRound(6)).toBeNull(); // already started
  });

  it('does not start the next round while someone is disconnected', () => {
    const l = playing();
    l.result('alice-1', 'cleared');
    l.disconnect('bob-123');
    expect(l.nextRound(5)).toBeNull();
    l.join('bob-123', 'Bob');
    expect(l.nextRound(5)).not.toBeNull();
  });

  it(`${ROUNDS_TO_WIN} round wins ends the match (2–0 keeps going) and returns the room to the lobby`, () => {
    const l = playing();
    for (let w = 1; w < ROUNDS_TO_WIN; w++) {
      const mid = l.result('alice-1', 'cleared')!;
      expect(mid.matchOver).toBe(false);
      l.nextRound(w + 1);
    }
    const r = l.result('bob-123', 'toppedOut')!;
    expect(r.wins['alice-1']).toBe(ROUNDS_TO_WIN);
    expect(r.matchOver).toBe(true);
    expect(r.nextInMs).toBeNull();
    expect(l.state.phase).toBe('lobby');
    expect(l.state.players.every(p => !p.ready)).toBe(true);
    expect(l.state.settings).toEqual({ fastGarbage: false });
  });

  it('play again: the next match starts once both players have asked, without the host pressing Start', () => {
    const l = playing();
    for (let w = 0; w < ROUNDS_TO_WIN; w++) {
      l.result('bob-123', 'cleared');
      l.nextRound(w + 2);
    }
    expect(l.state.phase).toBe('lobby');
    const first = l.playAgain('bob-123', 50); // the non-host asks first
    expect(first.ok && first.value).toBeNull();
    expect(l.state.phase).toBe('lobby');
    const second = l.playAgain('alice-1', 51);
    expect(second.ok && second.value && second.value.round).toBe(1);
    expect(l.state.phase).toBe('playing');
  });

  it('a player who never comes back loses the match', () => {
    const l = playing();
    l.disconnect('bob-123');
    const r = l.abandon('bob-123')!;
    expect(r.winner).toBe('alice-1');
    expect(r.reason).toBe('disconnect');
    expect(r.matchOver).toBe(true);
  });

  it('a mid-match disconnect keeps the ready flag (it only resets in the lobby)', () => {
    const l = playing();
    l.disconnect('bob-123');
    expect(l.state.players[1].ready).toBe(true);
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
