import { ZzfxParams } from './zzfx';
import { Pattern } from './zzfxm';

// Sound effects as ZzFX parameter lists. Tweak them at https://killedbyapixel.github.io/ZzFX/
// [volume, randomness, frequency, attack, sustain, release, shape, shapeCurve, slide, deltaSlide,
//  pitchJump, pitchJumpTime, repeatTime, noise, ...]
export const SFX = {
  move: [.2, 0, 520, 0, .01, .03, 1, 1],
  rotate: [.22, 0, 660, 0, .015, .04, 1, 1, 0, 0, 220, .02],
  lock: [.55, 0, 150, 0, .03, .09, 1, 1, -.7, 0, 0, 0, 0, .15], // a weightier thunk
  clear: [.5, 0, 440, .005, .04, .18, 0, 1, .6], // pitched up with each chain step
  germ: [.55, 0, 320, 0, .03, .14, 2, 1, -3, 0, 0, 0, 0, .15], // germ squished
  chain: [.35, 0, 660, .01, .05, .22, 0, 1, 0, 0, 330, .06], // sparkle on chain steps 2+
  attack: [.35, 0, 260, .02, .06, .18, 2, 1, 1.5], // you sent garbage
  warning: [.4, 0, 880, 0, .05, .1, 5, .5, 0, 0, -220, .07, .16], // garbage just sent your way (two-tone alarm)
  incoming: [.3, 0, 330, 0, .03, .08, 5, 1, -1.5], // garbage appears at the top
  thud: [.8, 0, 85, 0, .05, .22, 0, 1, -.5, 0, 0, 0, 0, .6], // garbage lands
  tone: [.35, 0, 523.25, .005, .08, .18, 5, 1], // jingle notes (C5)
  toneLow: [.45, 0, 261.63, .01, .12, .25, 1, 1], // sad jingle notes (C4)
} satisfies Record<string, ZzfxParams>;

export type SfxName = keyof typeof SFX;

/** Jingles: [sound, semitone offsets, seconds per note]. */
export const JINGLES = {
  win: ['tone', [0, 4, 7, 12, 7, 12, 16], .09],
  lose: ['toneLow', [0, -3, -6, -9, -12], .16],
  speedUp: ['tone', [7, 12, 19], .05], // quick rising chime when capsules start falling faster
} as const satisfies Record<string, readonly [SfxName, readonly number[], number]>;

// --- Test tune: an original, upbeat C–Am–F–G loop. Rows are 16th notes; 0 = no new note. ---

export const SONG_BPM = 140;

export const SONG_INSTRUMENTS: ZzfxParams[] = [
  [.35, 0, 261.63, .005, .07, .12, 5, 1], // 0 lead: square, note 12 = C4
  [.6, 0, 65.41, .005, .1, .08, 1, 1], // 1 bass: triangle, note 12 = C2
  [.8, 0, 120, 0, .03, .12, 0, 1, -1.2], // 2 kick
  [.3, 0, 180, 0, .02, .1, 4, 1], // 3 snare: noise
  [.12, 0, 300, 0, 0, .03, 4, 1], // 4 hi-hat: short noise
];

// Lead (C4 = 12, C5 = 24)
const leadC = [28, 0, 31, 0, 28, 0, 24, 0, 26, 0, 28, 0, 0, 0, 24, 0];
const leadAm = [21, 0, 24, 0, 28, 0, 24, 0, 23, 0, 21, 0, 0, 0, 16, 0];
const leadF = [17, 0, 21, 0, 24, 0, 21, 0, 29, 0, 28, 0, 26, 0, 24, 0];
const leadG = [26, 0, 0, 0, 23, 0, 19, 0, 26, 0, 28, 0, 26, 0, 0, 0];
const leadGEnd = [26, 0, 24, 0, 23, 0, 24, 0, 26, 0, 0, 0, 19, 0, 0, 0];

// Bass: root / octave eighth notes (C2 = 12)
const bassBar = (root: number) => Array.from({ length: 16 }, (_, i) => (i % 2 ? 0 : i % 4 ? root + 12 : root));

const kickBar = [12, 0, 0, 0, 0, 0, 0, 0, 12, 0, 0, 0, 0, 0, 0, 0];
const snareBar = [0, 0, 0, 0, 12, 0, 0, 0, 0, 0, 0, 0, 12, 0, 0, 0];
const hatBar = [0, 0, 12, 0, 0, 0, 12, 0, 0, 0, 12, 0, 0, 0, 12, 0];

function pattern(lead: number[][], bassRoots: number[]): Pattern {
  return [
    [0, 0, ...lead.flat()],
    [1, 0, ...bassRoots.flatMap(bassBar)],
    [2, 0, ...lead.flatMap(() => kickBar)],
    [3, .1, ...lead.flatMap(() => snareBar)],
    [4, -.2, ...lead.flatMap(() => hatBar)],
  ];
}

export const SONG_PATTERNS: Pattern[] = [
  pattern([leadC, leadAm], [12, 21]),
  pattern([leadF, leadG], [17, 19]),
  pattern([leadF, leadGEnd], [17, 19]),
];

export const SONG_SEQUENCE = [0, 1, 0, 2];
