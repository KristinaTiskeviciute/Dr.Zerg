import { ENDGAME_GERMS, ENDGAME_MUSIC_BOOST, MUSIC_MAX_RATE, MUSIC_SPEEDUP_PER_STEP } from '../config';
import { GameEvent } from '../core/game';
import { audio } from './audio';

/** The sound for one of your board's events (if it has one). */
export function playSound(e: GameEvent): void {
  switch (e.type) {
    case 'move': return audio.play('move');
    case 'rotate': return audio.play('rotate');
    case 'lock': return audio.play('lock');
    case 'clear': {
      const up = (e.chain - 1) * 3; // rises 3 semitones per chain step
      audio.play('clear', up, 0);
      if (e.germs > 0) audio.play('germ', up);
      if (e.chain >= 2) audio.play('chain', up, 0);
      return;
    }
    case 'garbageOut': return audio.play('attack');
    case 'garbageIn': return audio.play('incoming');
    case 'garbageLanded': return audio.play('thud');
  }
}

/**
 * Music tempo: a bit faster with every one of your speed-ups, and an extra push once any board
 * in play (`germs`: yours and everyone still in) is down to its last few germs.
 */
export function musicRate(speedStep: number, germs: number[]): number {
  const endgame = germs.some(g => g > 0 && g <= ENDGAME_GERMS);
  return Math.min(MUSIC_MAX_RATE, 1 + MUSIC_SPEEDUP_PER_STEP * speedStep) + (endgame ? ENDGAME_MUSIC_BOOST : 0);
}
