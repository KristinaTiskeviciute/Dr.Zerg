import { audio } from './audio/audio';
import { CPU_SKILLS, MAX_FRAME_MS, MAX_LEVEL, OPPONENT_BOARD_SCALE, ROUNDS_TO_WIN, SIM_STEP_MS } from './config';
import { CpuController } from './core/ai';
import { Game, GameEvent } from './core/game';
import { Match } from './core/match';
import { randomSeed } from './core/rng';
import { COLORS } from './core/types';
import { KeyboardInput } from './input/keyboard';
import { boardPixelSize, drawBoard, drawGerm } from './render/draw';
import { BoardEffects } from './render/effects';
import { gameView } from './render/view';
import { $, loadSettings, saveSettings, Settings, SKILL_LABEL, SPEED_LABEL } from './ui/dom';

const canvas = $<HTMLCanvasElement>('#board');
const ctx = canvas.getContext('2d')!;
const oppCanvas = $<HTMLCanvasElement>('#board-opp');
const oppCtx = oppCanvas.getContext('2d')!;
const keyboard = new KeyboardInput();
keyboard.attach();
const youFx = new BoardEffects();
const oppFx = new BoardEffects();

/** What's being played right now. Online play will become a third kind. */
type Session =
  | { kind: 'solo'; game: Game }
  | { kind: 'cpu'; match: Match; cpu: CpuController };

let settings: Settings = loadSettings();
let session: Session | null = null;
let paused = false;
let acc = 0;
let lastTime = performance.now();

/** Your own board in the current session. */
function you(): Game | null {
  if (!session) return null;
  return session.kind === 'solo' ? session.game : session.match.games[0];
}

/** True while boards should be advancing. */
function running(): boolean {
  if (!session || paused) return false;
  return session.kind === 'solo' ? !session.game.isOver : session.match.state === 'playing';
}

// --- Audio: unlocked by the first key press or click (browser rule) ---

window.addEventListener('keydown', () => audio.unlock(), { capture: true });
window.addEventListener('pointerdown', () => audio.unlock(), { capture: true });

const muteButton = $<HTMLButtonElement>('#toggle-mute');
const musicButton = $<HTMLButtonElement>('#toggle-music');
function renderAudioToggles(): void {
  muteButton.textContent = audio.muted ? '🔇 Sound' : '🔊 Sound';
  muteButton.classList.toggle('off', audio.muted);
  musicButton.textContent = '♪ Music';
  musicButton.classList.toggle('off', !audio.musicOn);
}
muteButton.addEventListener('click', () => { audio.toggleMute(); muteButton.blur(); });
musicButton.addEventListener('click', () => { audio.toggleMusic(); musicButton.blur(); });
window.addEventListener('keydown', e => {
  if (e.code === 'KeyM' && !e.repeat) audio.toggleMute();
});
audio.onChange(renderAudioToggles);
renderAudioToggles();

// --- Menu ---

/** Wire a row of buttons (data-value) to one setting. */
function bindSeg<K extends keyof Settings>(id: string, key: K, parse: (v: string) => Settings[K], show: (v: Settings[K]) => string) {
  const buttons = [...document.querySelectorAll<HTMLButtonElement>(`#${id} button`)];
  for (const b of buttons) {
    b.addEventListener('click', () => {
      settings[key] = parse(b.dataset.value!);
      saveSettings(settings);
      renderMenu();
    });
  }
  return () => { for (const b of buttons) b.classList.toggle('on', b.dataset.value === show(settings[key])); };
}

function bindLevel(id: string, key: 'level' | 'cpuLevel') {
  const input = $<HTMLInputElement>(`#${id}`);
  const out = $<HTMLOutputElement>(`#${id}-out`);
  input.addEventListener('input', () => {
    settings[key] = Number(input.value);
    saveSettings(settings);
    renderMenu();
  });
  return () => { input.value = String(settings[key]); out.value = String(settings[key]); };
}

const menuRenderers = [
  bindSeg('mode', 'mode', v => v as Settings['mode'], v => v),
  bindSeg('speed', 'speed', v => v as Settings['speed'], v => v),
  bindSeg('cpu-speed', 'cpuSpeed', v => v as Settings['cpuSpeed'], v => v),
  bindSeg('cpu-skill', 'cpuSkill', v => v as Settings['cpuSkill'], v => v),
  bindSeg('fast-garbage', 'fastGarbage', v => v === 'on', v => (v ? 'on' : 'off')),
  bindLevel('level', 'level'),
  bindLevel('cpu-level', 'cpuLevel'),
];

function renderMenu(): void {
  for (const r of menuRenderers) r();
  $('#menu').classList.toggle('cpu', settings.mode === 'cpu');
}

$('#start').addEventListener('click', () => (settings.mode === 'cpu' ? startCpuMatch() : startSolo(settings.level)));

function showMenu(): void {
  session = null;
  keyboard.enabled = false;
  audio.stopMusic();
  $('#play').classList.add('hidden');
  $('#menu').classList.remove('hidden');
  renderMenu();
  $('#start').focus();
}

// --- Starting games ---

function enterPlay(): void {
  paused = false;
  acc = 0;
  youFx.reset();
  oppFx.reset();
  keyboard.reset();
  keyboard.enabled = true;
  audio.startMusic();
  hideOverlay();
  $('#menu').classList.add('hidden');
  $('#play').classList.remove('hidden');
  $('#play').classList.toggle('vs', session?.kind === 'cpu');
  $('#hud-level').textContent = String(settings.level);
  $('#hud-speed').textContent = SPEED_LABEL[settings.speed];
  sizeCanvases();
}

function startSolo(level: number): void {
  settings.level = level;
  saveSettings(settings);
  session = { kind: 'solo', game: new Game({ level, speed: settings.speed, seed: randomSeed(), playerSalt: 'solo' }) };
  enterPlay();
}

function startCpuMatch(): void {
  const match = new Match({
    players: [
      { level: settings.level, speed: settings.speed },
      { level: settings.cpuLevel, speed: settings.cpuSpeed },
    ],
    seed: randomSeed(),
    fastGarbage: settings.fastGarbage,
  });
  session = { kind: 'cpu', match, cpu: new CpuController(CPU_SKILLS[settings.cpuSkill], randomSeed()) };
  $('#opp-label').textContent = `CPU · ${SKILL_LABEL[settings.cpuSkill]} · Lv ${settings.cpuLevel}`;
  $('#hud-fast').classList.toggle('hidden', !settings.fastGarbage);
  enterPlay();
}

function nextRound(): void {
  if (session?.kind !== 'cpu') return;
  session.match.nextRound();
  session.cpu = new CpuController(CPU_SKILLS[settings.cpuSkill], randomSeed());
  paused = false;
  acc = 0;
  youFx.reset();
  oppFx.reset();
  keyboard.reset();
  audio.startMusic();
  hideOverlay();
}

/** Scale your board to fill the window height, leaving room for the HUD (and the CPU's board). */
function sizeCanvases(): void {
  const { width, height } = boardPixelSize(8, 16);
  const vs = session?.kind === 'cpu';
  const narrow = window.innerWidth <= 520;
  const availW = window.innerWidth - (narrow ? 32 : 260) - (vs ? 40 : 0);
  const availH = window.innerHeight - (narrow ? 120 : 32);
  // The canvases stay at sprite resolution; CSS scales them up with crisp (pixelated) edges.
  // Whole-number scales keep every pixel the same size, so prefer one when it's close.
  const fit = Math.max(1, Math.min(availW / (width * (vs ? 1 + OPPONENT_BOARD_SCALE : 1)), availH / height));
  const scale = fit - Math.floor(fit) < 0.35 ? Math.floor(fit) : fit;
  for (const [c, cx, s] of [[canvas, ctx, scale], [oppCanvas, oppCtx, scale * OPPONENT_BOARD_SCALE]] as const) {
    c.width = width;
    c.height = height;
    c.style.width = `${Math.round(width * s)}px`;
    c.style.height = `${Math.round(height * s)}px`;
    cx.imageSmoothingEnabled = false;
  }
}
window.addEventListener('resize', () => { if (session) sizeCanvases(); });

// --- Events and results ---

function handleYourEvents(events: GameEvent[]): void {
  for (const e of events) {
    playSound(e);
    if (e.type === 'spawn') keyboard.onNewCapsule();
  }
}

function playSound(e: GameEvent): void {
  switch (e.type) {
    case 'move': return audio.play('move');
    case 'rotate': return audio.play('rotate');
    case 'lock': return audio.play('lock');
    case 'clear': {
      const up = (e.chain - 1) * 3; // rises 3 semitones per chain step
      audio.play('clear', up, 0);
      if (e.germs > 0) audio.play('germ', up);
      if (e.chain >= 2) audio.play('chain', up, 0);
      return;
    }
    case 'garbageOut': return audio.play('attack');
    case 'garbageIn': return audio.play('incoming');
    case 'garbageLanded': return audio.play('thud');
  }
}

function onSoloOver(game: Game): void {
  audio.stopMusic();
  const lvl = game.level;
  if (game.phase === 'won') {
    audio.jingle('win');
    const buttons: [string, () => void][] = [];
    if (lvl < MAX_LEVEL) buttons.push([`Level ${lvl + 1}`, () => startSolo(lvl + 1)]);
    buttons.push(['Play again', () => startSolo(lvl)], ['Menu', showMenu]);
    showOverlay('Bottle clean!', `Level ${lvl} cleared`, buttons);
  } else {
    audio.jingle('lose');
    showOverlay('Topped out', `${game.germsLeft} germs left`, [['Retry', () => startSolo(lvl)], ['Menu', showMenu]]);
  }
}

function onRoundOver(match: Match): void {
  audio.stopMusic();
  const [me, cpu] = match.games;
  const why =
    me.phase === 'won' ? 'You cleared your bottle' :
    cpu.phase === 'lost' ? 'The CPU topped out' :
    me.phase === 'lost' ? 'You topped out' :
    'The CPU cleared its bottle';
  const score = `You ${match.wins[0]} – ${match.wins[1]} CPU`;
  if (match.roundWinner === 0) audio.jingle('win');
  else if (match.roundWinner === 1) audio.jingle('lose');

  if (match.state === 'matchOver') {
    const title = match.matchWinner === 0 ? 'You win the match!' : 'The CPU wins';
    showOverlay(title, `${why}. ${score}`, [['Rematch', startCpuMatch], ['Menu', showMenu]]);
  } else {
    const title =
      match.roundWinner === 0 ? `You take round ${match.round}` :
      match.roundWinner === 1 ? `CPU takes round ${match.round}` :
      'Draw!';
    showOverlay(title, match.roundWinner === null ? score : `${why}. ${score}`, [['Next round', nextRound], ['Menu', showMenu]]);
  }
}

function togglePause(): void {
  if (!running() && !paused) return;
  paused = !paused;
  audio.setMusicPaused(paused);
  keyboard.reset();
  if (paused) showOverlay('Paused', 'Press P to resume', [['Resume', togglePause], ['Quit to menu', showMenu]]);
  else hideOverlay();
}

window.addEventListener('keydown', e => {
  if (!session) return;
  if ((e.code === 'KeyP' || e.code === 'Escape') && !e.repeat) {
    togglePause();
    e.preventDefault();
  }
  // Debug: send yourself 2–4 garbage pieces.
  const me = you();
  if (import.meta.env.DEV && e.code === 'Digit9' && !e.repeat && me && running()) {
    const n = 2 + Math.floor(Math.random() * 3);
    me.receiveGarbage(Array.from({ length: n }, () => COLORS[Math.floor(Math.random() * 3)]));
    youFx.markIncoming();
    audio.play('warning', 0, 0);
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

// --- Title screen: the three germs hopping ---

const mascots = $<HTMLCanvasElement>('#mascots');
const mascotCtx = mascots.getContext('2d')!;
mascots.width = 16 * 3 + 8 * 2;
mascots.height = 20;
function drawMascots(now: number): void {
  mascotCtx.clearRect(0, 0, mascots.width, mascots.height);
  COLORS.forEach((color, i) => {
    const beat = Math.floor(now / 300 + i) % 3;
    drawGerm(mascotCtx, i * 24, beat === 0 ? 1 : 4, color, beat === 0 ? 1 : 0);
  });
}

// --- HUD ---

function setText(id: string, text: string): void {
  const el = $(id);
  if (el.textContent !== text) el.textContent = text;
}

function renderPips(id: string, wins: number): void {
  const el = $(id);
  if (el.childElementCount === ROUNDS_TO_WIN && el.dataset.wins === String(wins)) return;
  el.dataset.wins = String(wins);
  el.replaceChildren(...Array.from({ length: ROUNDS_TO_WIN }, (_, i) => {
    const pip = document.createElement('span');
    pip.className = i < wins ? 'pip on' : 'pip';
    return pip;
  }));
}

// --- Loop: fixed-step simulation on the real clock, render every frame ---

function step(): void {
  if (!session) return;
  const input = keyboard.poll(SIM_STEP_MS);
  if (session.kind === 'solo') {
    const g = session.game;
    g.step(SIM_STEP_MS, input);
    const events = g.drainEvents();
    handleYourEvents(events);
    youFx.onEvents(events);
    if (g.isOver) onSoloOver(g);
  } else {
    const { match, cpu } = session;
    const [mine, theirs] = match.step(SIM_STEP_MS, [input, cpu.poll(match.games[1], SIM_STEP_MS)]);
    handleYourEvents(mine);
    youFx.onEvents(mine);
    oppFx.onEvents(theirs);
    // Warn the moment garbage is sent, not just when it starts falling.
    if (theirs.some(e => e.type === 'garbageOut')) {
      youFx.markIncoming();
      audio.play('warning', 0, 0);
    }
    if (mine.some(e => e.type === 'garbageOut')) oppFx.markIncoming();
    if (match.state !== 'playing') onRoundOver(match);
  }
}

/** Shake a board's canvas (in sprite pixels, converted to screen pixels). */
function applyShake(c: HTMLCanvasElement, fx: BoardEffects, now: number): void {
  const { x, y } = fx.shake(now);
  const scale = c.clientWidth / c.width || 1;
  const t = x || y ? `translate(${x * scale}px, ${y * scale}px)` : '';
  if (c.style.transform !== t) c.style.transform = t;
}

function frame(now: number): void {
  const dt = Math.min(now - lastTime, MAX_FRAME_MS);
  lastTime = now;

  if (running()) {
    acc += dt;
    while (acc >= SIM_STEP_MS && running()) {
      step();
      acc -= SIM_STEP_MS;
    }
  }

  const me = you();
  if (!session) drawMascots(now);
  if (session && me) {
    if (!paused) {
      youFx.update(dt);
      oppFx.update(dt);
    }
    applyShake(canvas, youFx, now);
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    if (!paused) drawBoard(ctx, gameView(me, youFx), 0, 0, now);
    setText('#hud-germs', String(me.germsLeft));
    if (session.kind === 'cpu') {
      const opp = session.match.games[1];
      applyShake(oppCanvas, oppFx, now);
      oppCtx.clearRect(0, 0, oppCanvas.width, oppCanvas.height);
      if (!paused) drawBoard(oppCtx, gameView(opp, oppFx), 0, 0, now);
      setText('#hud-opp-germs', String(opp.germsLeft));
      renderPips('#pips-you', session.match.wins[0]);
      renderPips('#pips-opp', session.match.wins[1]);
    }
  }
  requestAnimationFrame(frame);
}

// Dev shortcuts: ?play=7 jumps into solo level 7; ?cpu=7 into a CPU match with you at level 7;
// ?mode=cpu opens the menu in Vs CPU mode.
const params = new URLSearchParams(location.search);
if (import.meta.env.DEV && params.get('mode') === 'cpu') settings.mode = 'cpu';
showMenu();
if (import.meta.env.DEV && params.has('play')) startSolo(Math.min(MAX_LEVEL, Number(params.get('play')) || 0));
if (import.meta.env.DEV && params.has('cpu')) {
  settings.level = Math.min(MAX_LEVEL, Number(params.get('cpu')) || 0);
  startCpuMatch();
}
// ?garbage=6 queues that many garbage pieces on your board at the start (to see the incoming preview).
if (import.meta.env.DEV && params.has('garbage')) {
  you()?.receiveGarbage(Array.from({ length: Number(params.get('garbage')) || 4 }, (_, i) => COLORS[i % 3]));
}
requestAnimationFrame(frame);
