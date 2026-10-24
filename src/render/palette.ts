import { Color } from '../core/types';

export interface Shade {
  outline: string;
  base: string;
  light: string;
  dark: string;
}

export const SHADES: Record<Color, Shade> = {
  [Color.Red]: { outline: '#4a0b1c', base: '#e8383d', light: '#ff8e7a', dark: '#a61f34' },
  [Color.Yellow]: { outline: '#4f3000', base: '#ffc531', light: '#fff38a', dark: '#d38810' },
  [Color.Blue]: { outline: '#0c2160', base: '#3a86ff', light: '#8fd3ff', dark: '#2154c8' },
};

export const INK = {
  white: '#ffffff',
  pupil: '#170f24',
  glint: '#ffffff',
};

export const BOTTLE = {
  glassA: '#151935',
  glassB: '#191e3e',
  frame: '#d6e0ff',
  frameShade: '#7d89c9',
  frameDark: '#2a3170',
  shine: 'rgba(255,255,255,0.07)',
};
