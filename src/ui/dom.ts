import { MAX_LEVEL, MIN_LEVEL, Speed } from '../config';

export function $<T extends HTMLElement = HTMLElement>(selector: string): T {
  const el = document.querySelector<T>(selector);
  if (!el) throw new Error(`missing element ${selector}`);
  return el;
}

export interface Settings {
  level: number;
  speed: Speed;
}

export const SPEED_LABEL: Record<Speed, string> = { low: 'Low', med: 'Med', high: 'Hi' };

const KEY = 'drzerg.settings';
const DEFAULTS: Settings = { level: 5, speed: 'med' };

/** Remembered menu choices. Browser storage may be unavailable; fall back to defaults. */
export function loadSettings(): Settings {
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) ?? 'null');
    if (raw && typeof raw.level === 'number' && raw.speed in SPEED_LABEL) {
      return { level: Math.min(MAX_LEVEL, Math.max(MIN_LEVEL, raw.level)), speed: raw.speed };
    }
  } catch { /* ignore */ }
  return { ...DEFAULTS };
}

export function saveSettings(s: Settings): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(s));
  } catch { /* ignore */ }
}
