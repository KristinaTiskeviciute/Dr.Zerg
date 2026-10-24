import { MAX_FRAME_MS, MAX_LEVEL, SIM_STEP_MS, Speed } from './config';
import { Game, GameEvent } from './core/game';
import { randomSeed } from './core/rng';
import { COLORS } from './core/types';
import { KeyboardInput } from './input/keyboard';
import { boardPixelSize, drawBoard } from './render/draw';
import { gameView } from './render/view';
import { $, loadSettings, saveSettings, Settings, SPEED_LABEL } from './ui/dom';

const canvas = $<HTMLCanvasElement>('#board');
const ctx = canvas.getContext('2d')!;
const keyboard = new KeyboardInput();
keyboard.attach();

let settings: Settings = loadSettings();
let game: Game | null = null;
let paused = false;
let acc = 0;
let lastTime = performance.now();

// --- Menu ---

const levelInput = $<HTMLInputElement>('#level');
const levelOut = $<HTMLOutputElement>('#level-out');
const speedButtons = [...document.querySelectorAll<HTMLButtonElement>('#speed button')];

function renderMenu(): void {
  levelInput.value = String(settings.level);
  levelOut.value = String(settings.level);
  for (const b of speedButtons) b.classList.toggle('on', b.dataset.speed === settings.speed);
}

levelInput.addEventListener('input', () => {
  settings.level = Number(levelInput.value);
  saveSettings(settings);
  renderMenu();
});
for (const b of speedButtons) {
  b.addEventListener('click', () => {
    settings.speed = b.dataset.speed as Speed;
    saveSettings(settings);
    renderMenu();
  });
}
$('#start').addEventListener('click', () => startGame(settings.level));

function showMenu(): void {
  game = null;
  keyboard.enabled = false;
  $('#play').classList.add('hidden');
  $('#menu').classList.remove('hidden');
  renderMenu();
  $('#start').focus();
}

// --- Game ---

/** Scale the board to fill the window height (leaving room for the HUD beside it). */
function sizeCanvas(): void {
  const { width, height } = boardPixelSize(8, 16);
  const narrow = window.innerWidth <= 520;
  const availW = window.innerWidth - (narrow ? 32 : 220);
  const availH = window.innerHeight - (narrow ? 120 : 32);
  const scale = Math.max(0.5, Math.min(availW / width, availH / height));
  const dpr = window.devicePixelRatio || 1;
  canvas.width = Math.round(width * scale * dpr);
  canvas.height = Math.round(height * scale * dpr);
  canvas.style.width = `${Math.round(width * scale)}px`;
  canvas.style.height = `${Math.round(height * scale)}px`;
  ctx.setTransform(dpr * scale, 0, 0, dpr * scale, 0, 0);
}
window.addEventListener('resize', () => { if (game) sizeCanvas(); });

function startGame(level: number): void {
  settings.level = level;
  saveSettings(settings);
  game = new Game({ level, speed: settings.speed, seed: randomSeed(), playerSalt: 'solo' });
  paused = false;
  acc = 0;
  keyboard.reset();
  keyboard.enabled = true;
  hideOverlay();
  $('#menu').classList.add('hidden');
  $('#play').classList.remove('hidden');
  $('#hud-level').textContent = String(level);
  $('#hud-speed').textContent = SPEED_LABEL[settings.speed];
  sizeCanvas();
}

function handleEvents(events: GameEvent[]): void {
  for (const e of events) {
    if (e.type === 'won') {
      const lvl = game!.level;
      const buttons: [string, () => void][] = [];
      if (lvl < MAX_LEVEL) buttons.push([`Level ${lvl + 1}`, () => startGame(lvl + 1)]);
      buttons.push(['Play again', () => startGame(lvl)], ['Menu', showMenu]);
      showOverlay('Bottle clean!', `Level ${lvl} cleared`, buttons);
    } else if (e.type === 'lost') {
      const lvl = game!.level;
      showOverlay('Topped out', `${game!.germsLeft} germs left`, [['Retry', () => startGame(lvl)], ['Menu', showMenu]]);
    }
  }
}

function togglePause(): void {
  if (!game || game.isOver) return;
  paused = !paused;
  keyboard.reset();
  if (paused) showOverlay('Paused', 'Press P to resume', [['Resume', togglePause], ['Quit to menu', showMenu]]);
  else hideOverlay();
}

window.addEventListener('keydown', e => {
  if (!game) return;
  if ((e.code === 'KeyP' || e.code === 'Escape') && !e.repeat) {
    togglePause();
    e.preventDefault();
  }
  // Debug: send yourself 2–4 garbage pieces to try out garbage before online play exists.
  if (import.meta.env.DEV && e.code === 'Digit9' && !e.repeat && !game.isOver) {
    const n = 2 + Math.floor(Math.random() * 3);
    game.receiveGarbage(Array.from({ length: n }, () => COLORS[Math.floor(Math.random() * 3)]));
  }
});

// --- Overlay ---

function showOverlay(title: string, sub: string, buttons: [string, () => void][]): void {
  $('#overlay-title').textContent = title;
  $('#overlay-sub').textContent = sub;
  const box = $('#overlay-buttons');
  box.replaceChildren(
    ...buttons.map(([label, onClick]) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.textContent = label;
      b.addEventListener('click', onClick);
      return b;
    }),
  );
  box.firstElementChild?.classList.add('primary');
  $('#overlay').classList.remove('hidden');
  (box.firstElementChild as HTMLButtonElement | null)?.focus();
}

function hideOverlay(): void {
  $('#overlay').classList.add('hidden');
}

// --- Loop: fixed-step simulation on the real clock, render every frame ---

function frame(now: number): void {
  const dt = Math.min(now - lastTime, MAX_FRAME_MS);
  lastTime = now;

  if (game && !paused && !game.isOver) {
    acc += dt;
    while (acc >= SIM_STEP_MS && !game.isOver) {
      game.step(SIM_STEP_MS, keyboard.poll(SIM_STEP_MS));
      acc -= SIM_STEP_MS;
      handleEvents(game.drainEvents());
    }
  }

  if (game) {
    ctx.save();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.restore();
    if (!paused) drawBoard(ctx, gameView(game), 0, 0, now);
    const germs = String(game.germsLeft);
    const hud = $('#hud-germs');
    if (hud.textContent !== germs) hud.textContent = germs;
  }
  requestAnimationFrame(frame);
}

showMenu();
// Dev shortcut: ?play=7 jumps straight into level 7.
const devLevel = new URLSearchParams(location.search).get('play');
if (import.meta.env.DEV && devLevel !== null) startGame(Math.min(MAX_LEVEL, Number(devLevel) || 0));
requestAnimationFrame(frame);
