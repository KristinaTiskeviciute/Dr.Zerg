import { Match } from '../core/match';
import { RoundResult } from '../net/protocol';

// What the result screens say after a round: a title and a line with why and the score.

export interface ResultText {
  title: string;
  sub: string;
}

/** Vs CPU: you (seat 0) against one CPU ("The CPU") or several (by name). */
export function cpuRoundText(match: Match, names: readonly string[]): ResultText {
  const n = match.playerCount;
  /** "You", "The CPU" (one opponent) or the CPU's name. */
  const who = (i: number) => (i === 0 ? 'You' : n === 2 ? 'The CPU' : names[i]);
  const w = match.roundWinner;
  const why =
    w === null ? 'Nobody made it' :
    match.games[w].phase === 'won' ? `${who(w)} cleared ${w === 0 ? 'your' : n === 2 ? 'its' : 'their'} bottle` :
    n === 2 ? `${who(1 - w)} topped out` :
    w === 0 ? "You're the last one standing" : `${who(w)} is the last one standing`;
  const score = n === 2
    ? `You ${match.wins[0]} – ${match.wins[1]} CPU`
    : names.map((name, i) => `${name} ${match.wins[i]}`).join(' · ');

  if (match.state === 'matchOver') {
    const mw = match.matchWinner!;
    return { title: mw === 0 ? 'You win the match!' : `${who(mw)} wins the match`, sub: `${why}. ${score}` };
  }
  const title =
    w === null ? 'Draw!' :
    w === 0 ? `You take round ${match.round}` :
    `${n === 2 ? 'CPU' : names[w]} takes round ${match.round}`;
  return { title, sub: w === null ? score : `${why}. ${score}` };
}

/** A local match: everyone on this screen is named (P1, P2, Spike…). */
export function localRoundText(match: Match, names: readonly string[]): ResultText {
  const w = match.roundWinner;
  const why =
    w === null ? 'Nobody made it' :
    match.games[w].phase === 'won' ? `${names[w]} cleared their bottle` :
    match.playerCount === 2 ? `${names[1 - w]} topped out` :
    `${names[w]} is the last one standing`;
  const score = match.playerCount === 2
    ? `${names[0]} ${match.wins[0]} – ${match.wins[1]} ${names[1]}`
    : names.map((name, i) => `${name} ${match.wins[i]}`).join(' · ');

  if (match.state === 'matchOver') return { title: `${names[match.matchWinner!]} wins the match!`, sub: `${why}. ${score}` };
  const title = w === null ? 'Draw!' : `${names[w]} takes round ${match.round}`;
  return { title, sub: w === null ? score : `${why}. ${score}` };
}

/** An online round, decided by the server. `me` is your id; `round` the round just played. */
export function onlineRoundText(r: RoundResult, me: string, opps: { id: string; name: string }[], round: number): ResultText {
  /** "You" or a player's name. */
  const who = (id: string) => (id === me ? 'You' : opps.find(o => o.id === id)?.name ?? 'Someone');
  const mine = r.by === me;
  const why =
    r.reason === 'cleared' ? `${who(r.by)} cleared ${mine ? 'your' : 'their'} bottle` :
    r.reason === 'toppedOut' ? `${who(r.by)} topped out` :
    r.reason === 'forfeit' ? `${who(r.by)} left the round` :
    r.reason === 'lastStanding' ? (mine ? "You're the last one standing" : `${who(r.by)} is the last one standing`) :
    `${who(r.by)} disconnected`;
  const score = opps.length === 1
    ? `You ${r.wins[me] ?? 0} – ${r.wins[opps[0].id] ?? 0} ${opps[0].name}`
    : [me, ...opps.map(o => o.id)].map(id => `${who(id)} ${r.wins[id] ?? 0}`).join(' · ');
  const iWon = r.winner === me;
  const winnerName = r.winner ? who(r.winner) : '';

  if (r.matchOver) {
    return { title: iWon ? 'You win the match!' : r.winner ? `${winnerName} wins the match` : 'Match over', sub: `${why}. ${score}` };
  }
  const title = !r.winner ? 'Draw!' : iWon ? `You take round ${round}` : `${winnerName} takes round ${round}`;
  return { title, sub: `${why}. ${score}. Next round coming up…` };
}
