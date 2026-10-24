import { CPU_SKILLS, CpuSkillName, MAX_LEVEL, MIN_LEVEL, Speed } from '../config';

export function $<T extends HTMLElement = HTMLElement>(selector: string): T {
  const el = document.querySelector<T>(selector);
  if (!el) throw new Error(`missing element ${selector}`);
  return el;
}

export type Mode = 'solo' | 'cpu';

export interface Settings {
  mode: Mode;
  level: number;
  speed: Speed;
  cpuSkill: CpuSkillName;
  cpuLevel: number;
  cpuSpeed: Speed;
  fastGarbage: boolean;
}

export const SPEED_LABEL: Record<Speed, string> = { low: 'Low', med: 'Med', high: 'Hi' };
export const SKILL_LABEL: Record<CpuSkillName, string> = { easy: 'Easy', normal: 'Normal', hard: 'Hard' };

const KEY = 'drzerg.settings';
const DEFAULTS: Settings = {
  mode: 'solo', level: 5, speed: 'med', cpuSkill: 'normal', cpuLevel: 5, cpuSpeed: 'med', fastGarbage: false,
};

const clampLevel = (n: unknown, fallback: number) =>
  typeof n === 'number' ? Math.min(MAX_LEVEL, Math.max(MIN_LEVEL, Math.round(n))) : fallback;
const isSpeed = (s: unknown): s is Speed => typeof s === 'string' && s in SPEED_LABEL;

/** Remembered menu choices. Browser storage may be unavailable; fall back to defaults. */
export function loadSettings(): Settings {
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) ?? 'null');
    if (raw && typeof raw === 'object') {
      return {
        mode: raw.mode === 'cpu' ? 'cpu' : 'solo',
        level: clampLevel(raw.level, DEFAULTS.level),
        speed: isSpeed(raw.speed) ? raw.speed : DEFAULTS.speed,
        cpuSkill: raw.cpuSkill in CPU_SKILLS ? raw.cpuSkill : DEFAULTS.cpuSkill,
        cpuLevel: clampLevel(raw.cpuLevel, DEFAULTS.cpuLevel),
        cpuSpeed: isSpeed(raw.cpuSpeed) ? raw.cpuSpeed : DEFAULTS.cpuSpeed,
        fastGarbage: raw.fastGarbage === true,
      };
    }
  } catch { /* ignore */ }
  return { ...DEFAULTS };
}

export function saveSettings(s: Settings): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(s));
  } catch { /* ignore */ }
}
