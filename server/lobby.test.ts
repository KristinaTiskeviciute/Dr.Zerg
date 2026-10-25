import { describe, expect, it } from 'vitest';
import { ROUNDS_TO_WIN } from '../src/config';
import { Color } from '../src/core/types';
import { makeRoomCode, normalizeRoomCode, parseClientMessage } from '../src/net/protocol';
import { Lobby } from './lobby';

const ids = ['alice-1', 'bob-123', 'carol-1', 'dave-12'];

/** A room with the first `n` players joined and ready (Alice is host). */
function ready(n = 2): Lobby {
  const l = new Lobby('ABCD');
  for (const id of ids.slice(0, n)) l.join(id, id.split('-')[0]);
  for (const id of ids.slice(0, n)) l.setReady(id, true);
  return l;
}
const twoReady = () => ready(2);

describe('Lobby', () => {
  it('makes the first player host and seats up to four', () => {
    const l = ready(4);
    expect(l.state.hostId).toBe('alice-1');
    expect(l.state.players.map(p => p.id)).toEqual(ids);
  });

  it('turns away a fifth player', () => {
    const l = ready(4);
    const r = l.join('eve-1234', 'Eve');
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
    expect(l.setSettings('bob-123', { fastGarbage: true }).ok).toBe(false);
    expect(l.setSettings('alice-1', { fastGarbage: true }).ok).toBe(true);
    expect(l.state.settings.fastGarbage).toBe(true);
  });

  it('starts only when the host asks and 2+ players are here and ready', () => {
    const l = new Lobby('ABCD');
    l.join('alice-1', 'Alice');
    l.setReady('alice-1', true);
    expect(l.start('alice-1', 1).ok).toBe(false); // alone
    l.join('bob-123', 'Bob');
    expect(l.start('alice-1', 1).ok).toBe(false); // Bob not ready
    l.setReady('bob-123', true);
    expect(l.start('bob-123', 1).ok).toBe(false); // not host
    l.join('carol-1', 'Carol');
    expect(l.start('alice-1', 1).ok).toBe(false); // Carol not ready
    l.setReady('carol-1', true);
    const r = l.start('alice-1', 42);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.seed).toBe(42);
      expect(r.value.players.map(p => p.id)).toEqual(['alice-1', 'bob-123', 'carol-1']);
      expect(r.value.startInMs).toBeGreaterThan(0);
    }
    expect(l.state.phase).toBe('playing');
  });

  it('locks settings, setups and new joins during a match', () => {
    const l = twoReady();
    l.start('alice-1', 1);
    expect(l.setSettings('alice-1', { fastGarbage: true }).ok).toBe(false);
    expect(l.setup('bob-123', 9, 'high').ok).toBe(false);
    const r = l.join('carol-1', 'Carol');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe('inProgress');
  });

  it('freeing a seat mid-match ends a 2-player match', () => {
    const l = twoReady();
    l.start('alice-1', 1);
    l.disconnect('bob-123');
    l.remove('bob-123');
    expect(l.state.phase).toBe('lobby');
    expect(l.inMatch).toBe(false);
  });

  it('back to lobby keeps settings and clears ready flags', () => {
    const l = twoReady();
    l.setSettings('alice-1', { fastGarbage: true });
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

describe('match (2 players)', () => {
  function playing(): Lobby {
    const l = twoReady();
    l.start('alice-1', 1);
    return l;
  }

  it('clearing your bottle wins the round; topping out loses it', () => {
    const l = playing();
    const r1 = l.result('alice-1', 'cleared')!.round!;
    expect(r1.winner).toBe('alice-1');
    expect(r1.wins).toEqual({ 'alice-1': 1, 'bob-123': 0 });
    expect(r1.matchOver).toBe(false);
    expect(r1.nextInMs).toBeGreaterThan(0);

    l.nextRound(2);
    const r2 = l.result('alice-1', 'toppedOut')!;
    expect(r2.out).toEqual({ id: 'alice-1', reason: 'toppedOut' });
    expect(r2.round!.winner).toBe('bob-123');
    expect(r2.round!.reason).toBe('toppedOut');
  });

  it('the first result decides the round; a late second one is ignored', () => {
    const l = playing();
    expect(l.result('bob-123', 'cleared')!.round!.winner).toBe('bob-123');
    expect(l.result('alice-1', 'cleared')).toBeNull();
  });

  it('a forfeit (reload mid-round) gives the round to the other player', () => {
    const l = playing();
    expect(l.result('bob-123', 'forfeit')!.round!.winner).toBe('alice-1');
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
      const mid = l.result('alice-1', 'cleared')!.round!;
      expect(mid.matchOver).toBe(false);
      l.nextRound(w + 1);
    }
    const r = l.result('bob-123', 'toppedOut')!.round!;
    expect(r.wins['alice-1']).toBe(ROUNDS_TO_WIN);
    expect(r.matchOver).toBe(true);
    expect(r.nextInMs).toBeNull();
    expect(l.state.phase).toBe('lobby');
    expect(l.state.players.every(p => !p.ready)).toBe(true);
    expect(l.state.settings).toEqual({ fastGarbage: false, outbreak: false });
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
    const r = l.abandon('bob-123')!.round!;
    expect(r.winner).toBe('alice-1');
    expect(r.reason).toBe('disconnect');
    expect(r.matchOver).toBe(true);
  });

  it('a mid-match disconnect keeps the ready flag (it only resets in the lobby)', () => {
    const l = playing();
    l.disconnect('bob-123');
    expect(l.state.players[1].ready).toBe(true);
  });

  it('garbage always goes to the other player', () => {
    const l = playing();
    expect(l.garbageTargets('alice-1', [Color.Red])).toEqual(['bob-123']);
    expect(l.garbageTargets('bob-123', [Color.Yellow])).toEqual(['alice-1']);
  });
});

describe('match (3–4 players)', () => {
  function playing(n: number): Lobby {
    const l = ready(n);
    l.start('alice-1', 1);
    return l;
  }

  it('topping out knocks you out; the last one standing wins the round', () => {
    const l = playing(3);
    const r1 = l.result('bob-123', 'toppedOut')!;
    expect(r1.out).toEqual({ id: 'bob-123', reason: 'toppedOut' });
    expect(r1.round).toBeNull(); // two still in
    expect(l.result('bob-123', 'toppedOut')).toBeNull(); // already out
    const r2 = l.result('alice-1', 'toppedOut')!;
    expect(r2.round!.winner).toBe('carol-1');
    expect(r2.round!.reason).toBe('lastStanding');
    expect(r2.round!.by).toBe('carol-1');
  });

  it('clearing your bottle wins straight away, even with others still in', () => {
    const l = playing(4);
    l.result('dave-12', 'toppedOut');
    expect(l.result('carol-1', 'cleared')!.round!.winner).toBe('carol-1');
  });

  it('the server targets garbage by first-clear color, skipping players who are out', () => {
    const l = playing(4);
    expect(l.garbageTargets('alice-1', [Color.Blue])).toEqual(['bob-123']);
    expect(l.garbageTargets('alice-1', [Color.Yellow])).toEqual(['carol-1']);
    expect(l.garbageTargets('alice-1', [Color.Red])).toEqual(['dave-12']);
    l.result('bob-123', 'toppedOut');
    expect(l.garbageTargets('alice-1', [Color.Blue])).toEqual(['carol-1']);
    expect(l.garbageTargets('bob-123', [Color.Blue])).toEqual([]); // out players send nothing
  });

  it('the next round brings everyone back in', () => {
    const l = playing(3);
    l.result('bob-123', 'toppedOut');
    l.result('alice-1', 'toppedOut');
    expect(l.outPlayers.sort()).toEqual(['alice-1', 'bob-123']);
    l.nextRound(9);
    expect(l.outPlayers).toEqual([]);
  });

  it('someone who leaves for good is knocked out, and the match goes on without them', () => {
    const l = playing(3);
    l.disconnect('carol-1');
    const r = l.abandon('carol-1')!;
    expect(r.out).toEqual({ id: 'carol-1', reason: 'disconnect' });
    expect(r.round).toBeNull();
    l.remove('carol-1');
    expect(l.inMatch).toBe(true);
    // Alice and Bob carry on as a 2-player match.
    const end = l.result('bob-123', 'cleared')!.round!;
    expect(Object.keys(end.wins).sort()).toEqual(['alice-1', 'bob-123']);
    expect(l.nextRound(3)!.players.map(p => p.id)).toEqual(['alice-1', 'bob-123']);
  });
});

describe('protocol', () => {
  it('accepts valid messages and rejects junk', () => {
    expect(parseClientMessage('{"t":"join","playerId":"abc123","name":"  Kris  "}')).toEqual({ t: 'join', playerId: 'abc123', name: 'Kris' });
    expect(parseClientMessage('{"t":"setup","level":21,"speed":"med"}')).toBeNull();
    expect(parseClientMessage('{"t":"setup","level":7,"speed":"warp"}')).toBeNull();
    expect(parseClientMessage('{"t":"garbage","colors":[0,1],"firstColors":[1]}')).toEqual({ t: 'garbage', colors: [0, 1], firstColors: [1] });
    expect(parseClientMessage('{"t":"garbage","colors":[0,1]}')).toBeNull(); // firstColors required
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

describe('Outbreak mode', () => {
  it('the host turns it on; then every chain hits everyone still in', () => {
    const l = ready(4);
    expect(l.setSettings('bob-123', { outbreak: true }).ok).toBe(false); // not host
    expect(l.setSettings('alice-1', { outbreak: true }).ok).toBe(true);
    expect(l.state.settings).toEqual({ fastGarbage: false, outbreak: true });
    l.start('alice-1', 1);
    expect(l.garbageTargets('alice-1', [Color.Blue])).toEqual(['bob-123', 'carol-1', 'dave-12']);
    l.result('carol-1', 'toppedOut');
    expect(l.garbageTargets('bob-123', [Color.Red])).toEqual(['dave-12', 'alice-1']);
  });

  it('changing one setting leaves the other alone', () => {
    const l = ready(2);
    l.setSettings('alice-1', { fastGarbage: true });
    l.setSettings('alice-1', { outbreak: true });
    expect(l.state.settings).toEqual({ fastGarbage: true, outbreak: true });
  });
});
