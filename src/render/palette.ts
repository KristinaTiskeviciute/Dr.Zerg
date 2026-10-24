import { Color } from '../core/types';

export interface Shade {
  base: string;
  light: string;
  dark: string;
}

export const SHADES: Record<Color, Shade> = {
  [Color.Red]: { base: '#e5484d', light: '#ff9ea1', dark: '#8f1d22' },
  [Color.Yellow]: { base: '#f5c443', light: '#fff0b3', dark: '#9a6b00' },
  [Color.Blue]: { base: '#3e8ee8', light: '#a8d1ff', dark: '#163f80' },
};

export const BOTTLE = {
  glass: '#1b1f33',
  frame: '#c9d3ff',
  frameDark: '#6f7bb3',
  grid: 'rgba(255,255,255,0.035)',
};
