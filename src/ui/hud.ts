import { ROUNDS_TO_WIN } from '../config';

export interface HudPlayer {
  wins: number;
  /** null = not known yet (e.g. no snapshot from an online opponent). */
  germs: number | null;
  /** Knocked out of this round. */
  out: boolean;
}

/**
 * The side panel's per-player parts: round stars and germ counts, one row per player
 * (you first). With a single player (solo) it's just your germ count.
 */
export class PlayersHud {
  private names: string[] = [];
  private last = '';

  constructor(private readonly rounds: HTMLElement, private readonly germs: HTMLElement) {}

  setPlayers(names: string[]): void {
    this.names = names;
    this.last = '';
    const solo = names.length === 1;
    this.rounds.replaceChildren(...names.map(name => {
      const row = document.createElement('div');
      row.className = 'pips-row';
      const pips = document.createElement('span');
      pips.className = 'pips';
      for (let i = 0; i < ROUNDS_TO_WIN; i++) {
        const pip = document.createElement('span');
        pip.className = 'pip';
        pips.append(pip);
      }
      const who = document.createElement('span');
      who.className = 'who-name';
      who.textContent = name;
      row.append(pips, who);
      return row;
    }));
    this.germs.replaceChildren(...names.map((name, i) => {
      const cell = document.createElement('div');
      if (i === 0) cell.classList.add('mine');
      const count = document.createElement('strong');
      count.textContent = '0';
      cell.append(count);
      if (!solo) {
        const who = document.createElement('span');
        who.className = 'who';
        who.textContent = name;
        cell.append(who);
      }
      return cell;
    }));
  }

  /** Cheap to call every frame: only touches the page when something changed. */
  update(players: HudPlayer[]): void {
    const key = JSON.stringify(players);
    if (key === this.last) return;
    this.last = key;
    players.forEach((p, i) => {
      const row = this.rounds.children[i];
      row?.classList.toggle('out', p.out);
      row?.querySelectorAll('.pip').forEach((pip, k) => pip.classList.toggle('on', k < p.wins));
      const cell = this.germs.children[i];
      if (!cell) return;
      cell.classList.toggle('out', p.out);
      cell.querySelector('strong')!.textContent = p.germs === null ? '–' : String(p.germs);
    });
  }

  get playerNames(): readonly string[] {
    return this.names;
  }
}
