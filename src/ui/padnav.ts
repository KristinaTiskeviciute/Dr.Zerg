import type { NavDir } from '../input/gamepad';

// Moving around the page with a controller: the D-pad picks the nearest button, slider or
// text box in that direction.

const CONTROLS = 'button, input[type="range"], input[type="text"]';

/** True while the controller is being used to get around (so the selection stays marked and focused). */
export function usingPad(): boolean {
  return document.body.classList.contains('pad-nav');
}

/** After a click: drop focus (so Space can't press it again), unless the controller is driving. */
export function blurUnlessPad(el: HTMLElement): void {
  if (!usingPad()) el.blur();
}

/** The controls you can get to: visible, enabled, not the chat box (no chat typing on a controller). */
export function focusables(root: ParentNode = document): HTMLElement[] {
  return [...root.querySelectorAll<HTMLElement>(CONTROLS)].filter(el =>
    !(el as HTMLButtonElement | HTMLInputElement).disabled
    && el.getClientRects().length > 0
    && !el.closest('.chat-form, .touch-pad'));
}

/** Focus the nearest control in that direction from the focused one. False if there's none. */
export function moveFocus(list: HTMLElement[], dir: NavDir): boolean {
  const cur = document.activeElement as HTMLElement | null;
  if (!cur || !list.includes(cur)) return false;
  const a = cur.getBoundingClientRect();
  const ax = a.left + a.width / 2;
  const ay = a.top + a.height / 2;
  let best: HTMLElement | null = null;
  let bestScore = Infinity;
  for (const el of list) {
    if (el === cur) continue;
    const b = el.getBoundingClientRect();
    const bx = b.left + b.width / 2;
    const by = b.top + b.height / 2;
    // Only controls past the current one's edge in that direction count; left/right stay on
    // the same row (so the end of a row doesn't jump to a far corner).
    const sameRow = b.top < a.bottom && b.bottom > a.top;
    const past =
      dir === 'up' ? b.bottom <= a.top + 2 :
      dir === 'down' ? b.top >= a.bottom - 2 :
      dir === 'left' ? sameRow && b.right <= a.left + 2 :
      sameRow && b.left >= a.right - 2;
    if (!past) continue;
    // Measured edge to edge, so a wide control right below (e.g. a text box) counts as straight ahead.
    const along = dir === 'up' ? a.top - b.bottom : dir === 'down' ? b.top - a.bottom : dir === 'left' ? a.left - b.right : b.left - a.right;
    const across = dir === 'up' || dir === 'down' ? gap(a.left, a.right, b.left, b.right) : gap(a.top, a.bottom, b.top, b.bottom);
    const score = Math.max(0, along) + across * 2 + Math.abs(dir === 'up' || dir === 'down' ? bx - ax : by - ay) * 0.01;
    if (score < bestScore) {
      bestScore = score;
      best = el;
    }
  }
  best?.focus();
  return best !== null;
}

/** Distance between two ranges on one axis (0 if they overlap). */
function gap(a0: number, a1: number, b0: number, b1: number): number {
  return Math.max(0, b0 - a1, a0 - b1);
}

/** Nudge a slider one step (about 5% of its range), as if dragged. */
export function stepRange(el: HTMLInputElement, dir: 1 | -1): void {
  const min = Number(el.min || 0);
  const max = Number(el.max || 100);
  const step = Math.max(Number(el.step) || 1, Math.round((max - min) / 20));
  const value = Math.min(max, Math.max(min, Number(el.value) + dir * step));
  if (value === Number(el.value)) return;
  el.value = String(value);
  el.dispatchEvent(new Event('input', { bubbles: true }));
  el.dispatchEvent(new Event('change', { bubbles: true }));
}
