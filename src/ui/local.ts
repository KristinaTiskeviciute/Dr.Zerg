import { CpuSkillName, MAX_LEVEL, MIN_LEVEL, Speed } from '../config';
import type { PadInfo } from '../input/gamepad';
import { $, saveSettings, Settings, SKILL_LABEL, SPEED_LABEL } from './dom';

/** A seat in a local match: a person (keyboard or a controller) or a CPU. */
export type LocalSeat =
  | { kind: 'person'; device: 'keyboard' | number; level: number; speed: Speed }
  | { kind: 'cpu'; level: number; speed: Speed; skill: CpuSkillName };

export const MAX_LOCAL_PLAYERS = 4;
/** CPU players are named after the germs. */
export const CPU_NAMES = ['Spike', 'Buzz', 'Peep'];
const SKILLS: CpuSkillName[] = ['easy', 'normal', 'hard'];
const SPEEDS: Speed[] = ['low', 'med', 'high'];
const next = <T>(list: T[], v: T): T => list[(list.indexOf(v) + 1) % list.length];

/** People are P1–P4 in seat order; CPUs are named after the germs. */
export function seatNames(seats: LocalSeat[]): string[] {
  let people = 0;
  let cpus = 0;
  return seats.map(s => (s.kind === 'person' ? `P${++people}` : CPU_NAMES[cpus++] ?? 'CPU'));
}

/** Short label for how a seat plays: ⌨, 🎮 2 or CPU Hard. */
export function deviceLabel(s: LocalSeat): string {
  if (s.kind === 'cpu') return `CPU ${SKILL_LABEL[s.skill]}`;
  return s.device === 'keyboard' ? '⌨' : `🎮 ${s.device + 1}`;
}

/**
 * The local match setup screen: people join by pressing ✕ on their controller (or with the
 * keyboard button), CPUs fill the other seats, everyone picks their level and speed.
 */
export class LocalSetup {
  seats: LocalSeat[] = [];
  /** The controllers the browser sees (updated as they connect). */
  private pads: PadInfo[] = [];

  constructor(
    private readonly settings: Settings,
    private readonly cb: { onStart(seats: LocalSeat[]): void; onBack(): void },
  ) {
    $('#local-keyboard').addEventListener('click', () => this.joinKeyboard());
    $('#local-add-cpu').addEventListener('click', () => {
      if (this.seats.length >= MAX_LOCAL_PLAYERS) return;
      this.seats.push({ kind: 'cpu', level: this.settings.cpuLevel, speed: this.settings.cpuSpeed, skill: this.settings.cpuSkill });
      this.render();
    });
    $('#local-start').addEventListener('click', () => { if (this.canStart) this.cb.onStart(this.seats.map(s => ({ ...s }))); });
    $('#local-back').addEventListener('click', () => this.cb.onBack());
    for (const [id, key] of [['#local-fast', 'fastGarbage'], ['#local-outbreak', 'outbreak']] as const) {
      for (const b of document.querySelectorAll<HTMLButtonElement>(`${id} button`)) {
        b.addEventListener('click', () => {
          this.settings[key] = b.dataset.value === 'on';
          saveSettings(this.settings);
          this.render();
        });
      }
    }
    // Buttons on each row: skill (CPUs), level −/+, speed, remove.
    $('#local-players').addEventListener('click', e => {
      const b = (e.target as Element).closest<HTMLButtonElement>('button[data-action]');
      const seat = b ? this.seats[Number(b.dataset.index)] : undefined;
      if (!b || !seat) return;
      switch (b.dataset.action) {
        case 'skill': if (seat.kind === 'cpu') seat.skill = next(SKILLS, seat.skill); break;
        case 'speed': seat.speed = next(SPEEDS, seat.speed); break;
        case 'down': seat.level = Math.max(MIN_LEVEL, seat.level - 1); break;
        case 'up': seat.level = Math.min(MAX_LEVEL, seat.level + 1); break;
        case 'remove': this.seats.splice(Number(b.dataset.index), 1); break;
      }
      this.render();
    });
  }

  get visible(): boolean {
    return !$('#local').classList.contains('hidden');
  }

  get canStart(): boolean {
    return this.seats.length >= 2 && this.seats.some(s => s.kind === 'person');
  }

  show(): void {
    for (const id of ['#menu', '#play', '#lobby']) $(id).classList.add('hidden');
    $('#local').classList.remove('hidden');
    this.render();
  }

  hide(): void {
    $('#local').classList.add('hidden');
  }

  /** The connected controllers changed. */
  setPads(pads: PadInfo[]): void {
    this.pads = pads;
    this.render();
  }

  /** A controller pressed ✕: it joins (true), unless it already has a seat or there's no room. */
  joinPad(index: number): boolean {
    if (!this.visible || this.seats.some(s => s.kind === 'person' && s.device === index)) return false;
    if (this.seats.length >= MAX_LOCAL_PLAYERS) return false;
    this.addPerson(index);
    return true;
  }

  joinKeyboard(): void {
    if (this.seats.some(s => s.kind === 'person' && s.device === 'keyboard') || this.seats.length >= MAX_LOCAL_PLAYERS) return;
    this.addPerson('keyboard');
  }

  /** People sit before the CPUs (P1 gets the big bottle). */
  private addPerson(device: 'keyboard' | number): void {
    const at = this.seats.filter(s => s.kind === 'person').length;
    this.seats.splice(at, 0, { kind: 'person', device, level: this.settings.level, speed: this.settings.speed });
    this.render();
  }

  /**
   * Which controllers the browser sees, and what each one should do next. Helps when a
   * controller "does nothing": not connected, not woken up yet, or an odd button layout.
   */
  private renderPads(names: string[]): void {
    const items = this.pads.map(p => {
      const li = document.createElement('li');
      const seat = this.seats.findIndex(s => s.kind === 'person' && s.device === p.index);
      const name = document.createElement('span');
      name.textContent = `🎮 ${p.index + 1} · ${p.name}`;
      const note = document.createElement('span');
      note.className = seat >= 0 ? 'ok' : 'hint';
      note.textContent = seat >= 0 ? `joined as ${names[seat]}` : `press ${p.xbox ? 'A' : '✕'} to join`;
      li.append(name, note);
      if (!p.standard) {
        const warn = document.createElement('span');
        warn.className = 'warn';
        warn.textContent = 'buttons may be mixed up in this browser (Chrome or Edge work best)';
        li.append(warn);
      }
      return li;
    });
    if (items.length === 0) {
      const li = document.createElement('li');
      li.className = 'hint';
      li.textContent = 'None yet. Connect a controller (Bluetooth or cable), then press any button on it: browsers only show a controller after a button press.';
      items.push(li);
    }
    $('#local-pads').replaceChildren(...items);
  }

  render(): void {
    if (!this.visible) return;
    const list = $('#local-players');
    const focusedKey = list.contains(document.activeElement) ? (document.activeElement as HTMLElement).dataset.key : undefined;
    const names = seatNames(this.seats);
    const items: HTMLElement[] = this.seats.map((seat, i) => {
      const li = document.createElement('li');
      li.className = 'seat-row';
      const who = document.createElement('span');
      who.className = 'who';
      who.textContent = `${names[i]} · ${seat.kind === 'cpu' ? 'CPU' : deviceLabel(seat)}`; // a CPU's skill is on its button
      li.append(who);
      const button = (text: string, action: string, title: string, disabled = false) => {
        const b = document.createElement('button');
        b.type = 'button';
        b.className = 'mini';
        b.textContent = text;
        b.title = title;
        b.disabled = disabled;
        b.dataset.action = action;
        b.dataset.index = String(i);
        b.dataset.key = `${i}:${action}`;
        li.append(b);
      };
      if (seat.kind === 'cpu') button(SKILL_LABEL[seat.skill], 'skill', 'Skill (click to change)');
      button('−', 'down', 'Level down', seat.level <= MIN_LEVEL);
      const lv = document.createElement('span');
      lv.className = 'meta';
      lv.textContent = `Lv ${seat.level}`;
      li.append(lv);
      button('+', 'up', 'Level up', seat.level >= MAX_LEVEL);
      button(SPEED_LABEL[seat.speed], 'speed', 'Speed (click to change)');
      button('✕', 'remove', seat.kind === 'cpu' ? 'Remove this CPU' : 'Leave');
      return li;
    });
    if (this.seats.length < MAX_LOCAL_PLAYERS) {
      const li = document.createElement('li');
      li.className = 'empty';
      li.textContent = `Press ✕ (A on Xbox) on a controller to join (${MAX_LOCAL_PLAYERS - this.seats.length} seat${this.seats.length === 3 ? '' : 's'} left)`;
      items.push(li);
    }
    list.replaceChildren(...items);
    if (focusedKey) list.querySelector<HTMLElement>(`[data-key="${focusedKey}"]`)?.focus();

    const full = this.seats.length >= MAX_LOCAL_PLAYERS;
    $<HTMLButtonElement>('#local-keyboard').disabled = full || this.seats.some(s => s.kind === 'person' && s.device === 'keyboard');
    $<HTMLButtonElement>('#local-add-cpu').disabled = full;
    $<HTMLButtonElement>('#local-start').disabled = !this.canStart;
    for (const [id, on] of [['#local-fast', this.settings.fastGarbage], ['#local-outbreak', this.settings.outbreak]] as const) {
      for (const b of document.querySelectorAll<HTMLButtonElement>(`${id} button`)) b.classList.toggle('on', (b.dataset.value === 'on') === on);
    }
    this.renderPads(names);
    $('#local-status').textContent =
      this.seats.length === 0 ? 'Everyone with a controller: press ✕ (A on Xbox) to join. Or join with the keyboard.' :
      !this.seats.some(s => s.kind === 'person') ? 'At least one person needs to join.' :
      this.seats.length < 2 ? 'Waiting for another player (or add a CPU).' :
      'Ready when you are.';
  }
}
