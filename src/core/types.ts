export enum Color {
  Red = 0,
  Yellow = 1,
  Blue = 2,
}

export const COLORS: readonly Color[] = [Color.Red, Color.Yellow, Color.Blue];

/** Direction from a capsule half to its partner. */
export type Link = 'none' | 'left' | 'right' | 'up' | 'down';

export type Cell =
  | { kind: 'germ'; color: Color }
  | { kind: 'pill'; color: Color; link: Link };

export interface Pos {
  row: number;
  col: number;
}
