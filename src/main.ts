import { audio } from './audio/audio';
import {
  BOARD_SNAPSHOT_HZ, CPU_SKILLS, MAX_FRAME_MS, MAX_LEVEL, OPPONENT_BOARD_SCALE, ROUNDS_TO_WIN, SIM_STEP_MS,
} from './config';
import { CpuController } from './core/ai';
import { Game, GameEvent } from './core/game';
import { Match } from './core/match';
import { randomSeed } from './core/rng';
import { COLORS } from './core/types';
import { GamepadInput } from './input/gamepad';
import { KeyboardInput } from './input/keyboard';
import { Rumble } from './input/rumble';
import { boardPixelSize, drawBoard, drawGerm } from './render/draw';
import { BoardEffects } from './render/effects';
import { gameView } from './render/view';
import {
  BoardSnapshot, makeRoomCode, normalizeRoomCode, RoundResult, START_COUNTDOWN_MS, StartInfo,
} from './net/protocol';
import { encodeSnapshot, snapshotView } from './net/snapshot';
import { $, loadSettings, saveSettings, Settings, SKILL_LABEL, SPEED_LABEL } from './ui/dom';
import { MatchMessage, OnlineRoom } from './ui/lobby';

const canvas = $<HTMLCanvasElement>('#board');
const ctx = canvas.getContext('2d')!;
const oppCanvas = $<HTMLCanvasElement>('#board-opp');
const oppCtx = oppCanvas.getContext('2d')!;
const keyboard = new KeyboardInput();
keyboard.attach();

// --- Game controller (e.g. PS5): feeds the same input as the keyboard, plus rumble ---

const pad = new GamepadInput(keyboard, {
  onPause: () => togglePause(),
  onConfirm: () => {
    // Between rounds and on menus: press the focused button (overlays focus their main button).
    if (running()) return false;
    const el = document.activeElement;
    if (el instanceof HTMLButtonElement && el.offsetParent !== null && !el.disabled) {
      el.click();
      return true;
    }
    return false;
  },
  onChange: () => renderPadUi(),
});
const rumble = new Rumble(pad);
const rumbleButton = $<HTMLButtonElement>('#toggle-rumble');
rumbleButton.addEventListener('click', () => { rumble.toggle(); renderPadUi(); rumbleButton.blur(); });
function renderPadUi(): void {
  const connected = pad.connected;
  rumbleButton.classList.toggle('hidden', !connected);
  rumbleButton.textContent = '🎮 Rumble';
  rumbleButton.classList.toggle('off', !rumble.on);
  $('#pad-hint').classList.toggle('hidden', !connected);
}
const youFx = new BoardEffects();
const oppFx = new BoardEffects();

/** What's being played right now. */
type Session =
  | { kind: 'solo'; game: Game }
  // startAt = end of the 3-2-1 countdown before each round.
  | { kind: 'cpu'; match: Match; cpu: CpuController; startAt: number }
  | OnlineSession;

/** An online round: your board runs here; the opponent's arrives as snapshots. */
interface OnlineSession {
  kind: 'online';
  game: Game;
  info: StartInfo;
  opponentId: string;
  opponentName: string;
  /** Play (re)starts at this time: after the start countdown, a pause or a reconnect. */
  startAt: number;
  /** Shared pause: who paused (null if not paused). */
  pausedBy: string | null;
  /** Opponent's connection dropped: they have until `until` to come back. */
  away: { name: string; until: number } | null;
  /** Latest snapshot of the opponent's board and when it arrived. */
  opp: { snap: BoardSnapshot | null; at: number };
  /** The round's result from the server, once decided. */
  result: RoundResult | null;
  resultSent: boolean;
  lastSent: { json: string; at: number };
}

/**
 * No word from the opponent for this long: pause both boards ("Connection problem…").
 * Background tabs only get timers about once a second, so keep this well above that.
 */
const STALE_MS = 3500;
/** Send your board at least this often, even if nothing changed (doubles as a heartbeat). */
const SNAPSHOT_KEEPALIVE_MS = 500;

let settings: Settings = loadSettings();
let session: Session | null = null;
let paused = false;
let acc = 0;
let lastTime = performance.now();

/** Your own board in the current session. */
function you(): Game | null {
  if (!session) return null;
  return session.kind === 'cpu' ? session.match.games[0] : session.game;
}

/** True while boards should be advancing. */
function running(): boolean {
  if (!session || paused) return false;
  switch (session.kind) {
    case 'solo': return !session.game.isOver;
    case 'cpu': return session.match.state === 'playing' && performance.now() >= session.startAt;
    case 'online': return onlineHold(session, performance.now()) === null;
  }
}

/** Why an online round isn't advancing right now, or null if it is. */
function onlineHold(s: OnlineSession, now: number): 'result' | 'over' | 'reconnecting' | 'away' | 'paused' | 'stale' | 'countdown' | null {
  if (s.result) return 'result';
  if (s.game.isOver) return 'over';
  if (!room.connected) return 'reconnecting';
  if (s.away) return 'away';
  if (s.pausedBy) return 'paused';
  if (now - s.opp.at > STALE_MS) return 'stale';
  if (now < s.startAt) return 'countdown';
  return null;
}

// --- Online room (lobby screen + connection) ---

const room = new OnlineRoom(settings, {
  onStart: startOnline,
  onMatchMessage: onMatchMessage,
  inMatch: () => session?.kind === 'online',
  onLeave: error => {
    showMenu();
    $('#menu-error').textContent = error ?? '';
  },
});

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
  $('#menu').classList.toggle('online', settings.mode === 'online');
  $<HTMLInputElement>('#menu-name').value = settings.name;
}

$('#start').addEventListener('click', () => (settings.mode === 'cpu' ? startCpuMatch() : startSolo(settings.level)));

$<HTMLInputElement>('#menu-name').addEventListener('input', e => {
  settings.name = (e.target as HTMLInputElement).value.trim().slice(0, 16);
  saveSettings(settings);
});
$('#create-room').addEventListener('click', () => room.enter(makeRoomCode()));
const joinCode = $<HTMLInputElement>('#join-code');
function joinTypedRoom(): void {
  const code = normalizeRoomCode(joinCode.value);
  if (code) room.enter(code);
  else $('#menu-error').textContent = 'Room codes are 4 letters, like KQTZ.';
}
$('#join-room').addEventListener('click', joinTypedRoom);
joinCode.addEventListener('keydown', e => { if (e.key === 'Enter') joinTypedRoom(); });

function showMenu(): void {
  session = null;
  keyboard.enabled = false;
  audio.stopMusic();
  $('#play').classList.add('hidden');
  $('#lobby').classList.add('hidden');
  $('#menu').classList.remove('hidden');
  $('#menu-error').textContent = '';
  renderMenu();
  (settings.mode === 'online' ? $('#create-room') : $('#start')).focus();
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
  $('#lobby').classList.add('hidden');
  $('#play').classList.remove('hidden');
  $('#play').classList.toggle('vs', session?.kind === 'cpu' || session?.kind === 'online');
  $('#play').classList.toggle('online', session?.kind === 'online');
  const me = you();
  $('#hud-level').textContent = String(me?.level ?? settings.level);
  $('#hud-speed').textContent = SPEED_LABEL[me?.speed ?? settings.speed];
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
  session = {
    kind: 'cpu', match, cpu: new CpuController(CPU_SKILLS[settings.cpuSkill], randomSeed()),
    startAt: performance.now() + START_COUNTDOWN_MS,
  };
  overlayKey = '';
  setOpponentLabels('CPU', `CPU · ${SKILL_LABEL[settings.cpuSkill]} · Lv ${settings.cpuLevel}`);
  $('#hud-fast').classList.toggle('hidden', !settings.fastGarbage);
  enterPlay();
}

function setOpponentLabels(name: string, boardLabel: string): void {
  $('#pips-opp-name').textContent = name;
  $('#hud-opp-germs-label').textContent = name;
  $('#opp-label').textContent = boardLabel;
}

/** A round starts (the first from the lobby, later ones automatically): your board on the shared seed. */
function startOnline(info: StartInfo): void {
  const me = info.players.find(p => p.id === room.me);
  const opp = info.players.find(p => p.id !== room.me);
  if (!me || !opp) return;
  const now = performance.now();
  session = {
    kind: 'online',
    game: new Game({ level: me.level, speed: me.speed, seed: info.seed, fastGarbage: info.settings.fastGarbage, playerSalt: me.id }),
    info,
    opponentId: opp.id,
    opponentName: opp.name,
    startAt: now + info.startInMs,
    pausedBy: null,
    away: null,
    opp: { snap: null, at: now },
    result: null,
    resultSent: false,
    lastSent: { json: '', at: 0 },
  };
  setOpponentLabels(opp.name, `${opp.name} · Lv ${opp.level} · ${SPEED_LABEL[opp.speed]}`);
  $('#hud-fast').classList.toggle('hidden', !info.settings.fastGarbage);
  overlayKey = '';
  enterPlay();
}

function onMatchMessage(msg: MatchMessage): void {
  if (session?.kind !== 'online') return;
  const s = session;
  const now = performance.now();
  switch (msg.t) {
    case 'board':
      if (msg.from === s.opponentId) s.opp = { snap: msg.snap, at: now };
      break;
    case 'garbage':
      if (msg.from === s.opponentId && !s.result) {
        s.game.receiveGarbage(msg.colors);
        youFx.markIncoming();
        audio.play('warning', 0, 0); rumble.warning();
      }
      break;
    case 'pause':
      s.pausedBy = msg.paused ? msg.by : null;
      if (!msg.paused) s.startAt = now + msg.resumeInMs;
      audio.setMusicPaused(msg.paused);
      keyboard.reset();
      break;
    case 'away':
      if (msg.id === s.opponentId) s.away = { name: msg.name, until: now + msg.graceMs };
      break;
    case 'back':
      // Either the opponent came back, or you did after a blip: resume after a countdown.
      if (msg.id === s.opponentId) s.away = null;
      s.startAt = now + msg.resumeInMs;
      s.opp.at = now;
      keyboard.reset();
      break;
    case 'round':
      onOnlineRound(s, msg);
      break;
  }
}

function onOnlineRound(s: OnlineSession, r: RoundResult): void {
  s.result = r;
  audio.stopMusic();
  if (r.winner) {
    audio.jingle(r.winner === room.me ? 'win' : 'lose');
    rumble.roundEnd(r.winner === room.me);
  }

  const who = (id: string) => (id === room.me ? 'You' : s.opponentName);
  const why =
    r.reason === 'cleared' ? `${who(r.by)} cleared ${r.by === room.me ? 'your' : 'their'} bottle` :
    r.reason === 'toppedOut' ? `${who(r.by)} topped out` :
    r.reason === 'forfeit' ? `${who(r.by)} left the round` :
    `${who(r.by)} disconnected`;
  const score = `You ${r.wins[room.me] ?? 0} – ${r.wins[s.opponentId] ?? 0} ${s.opponentName}`;
  const iWon = r.winner === room.me;
  overlayKey = 'result';
  if (r.matchOver) {
    showOverlay(iWon ? 'You win the match!' : `${s.opponentName} wins the match`, `${why}. ${score}`, [
      ['Play again', () => playAgainOnline(s)],
      ['Back to lobby', leaveOnlineMatch],
      ['Leave room', () => room.leave()],
    ]);
  } else {
    const round = s.info.round;
    showOverlay(iWon ? `You take round ${round}` : `${s.opponentName} takes round ${round}`, `${why}. ${score}. Next round coming up…`, []);
  }
}

/** Ready for another match with the same settings; it starts once the other player agrees. */
function playAgainOnline(s: OnlineSession): void {
  room.send({ t: 'playAgain' });
  showOverlay('Play again', `Waiting for ${s.opponentName}…`, [['Back to lobby', leaveOnlineMatch]]);
}

function leaveOnlineMatch(): void {
  session = null;
  keyboard.enabled = false;
  audio.stopMusic();
  room.backToLobby();
}

/** Your board ended on its own (cleared or topped out): tell the room. The server decides the round. */
function onOnlineOver(game: Game): void {
  if (session?.kind !== 'online' || session.resultSent) return;
  session.resultSent = true;
  room.send({ t: 'result', outcome: game.phase === 'won' ? 'cleared' : 'toppedOut' });
}

/** Send your board if it changed (at most BOARD_SNAPSHOT_HZ), or anyway every so often as a heartbeat. */
function sendBoard(s: OnlineSession, now: number): void {
  if (now - s.lastSent.at < 1000 / BOARD_SNAPSHOT_HZ) return;
  const json = JSON.stringify(encodeSnapshot(s.game));
  if (json !== s.lastSent.json || now - s.lastSent.at >= SNAPSHOT_KEEPALIVE_MS) {
    room.send({ t: 'board', snap: JSON.parse(json) });
    s.lastSent = { json, at: now };
  }
}

// Browsers stop requestAnimationFrame in hidden tabs, but timers keep running (about once a
// second). This keeps the heartbeat going so a backgrounded tab doesn't look disconnected.
setInterval(() => {
  if (session?.kind === 'online') sendBoard(session, performance.now());
}, SNAPSHOT_KEEPALIVE_MS);

/** Once per frame during an online round: send your board, and show the right overlay. */
function updateOnline(s: OnlineSession, now: number): void {
  sendBoard(s, now);

  const hold = onlineHold(s, now);
  if (hold === 'result') return; // result overlay is already up
  const secs = (t: number) => String(Math.max(0, Math.ceil((t - now) / 1000)));
  switch (hold) {
    case 'over':
      return setOverlayState('over', s.game.phase === 'won' ? 'Bottle clean!' : 'Topped out', 'Waiting for the result…', []);
    case 'reconnecting':
      return setOverlayState('reconnecting', 'Reconnecting…', 'Your connection dropped. Hang on…', []);
    case 'away':
      return setOverlayState('away', 'Opponent disconnected', `${s.away!.name} has ${secs(s.away!.until)} s to come back`, []);
    case 'paused':
      return setOverlayState('paused', 'Paused', `Paused by ${s.pausedBy}. Either of you can resume.`, [
        ['Resume', () => room.send({ t: 'pause', paused: false })],
        ['Leave room', () => room.leave()],
      ]);
    case 'stale':
      return setOverlayState('stale', 'Connection problem…', `Waiting to hear from ${s.opponentName}`, []);
    case 'countdown':
      return setOverlayState('countdown', secs(s.startAt), s.info.round > 1 ? `Round ${s.info.round}` : `vs ${s.opponentName}`, []);
    default:
      if (overlayKey) {
        overlayKey = '';
        hideOverlay();
      }
  }
}

/** Show an overlay unless that kind is already showing; same kind just updates its text. */
let overlayKey = '';
function setOverlayState(key: string, title: string, sub: string, buttons: [string, () => void][]): void {
  if (overlayKey === key) {
    setText('#overlay-title', title);
    setText('#overlay-sub', sub);
    return;
  }
  overlayKey = key;
  showOverlay(title, sub, buttons);
}

function nextRound(): void {
  if (session?.kind !== 'cpu') return;
  session.match.nextRound();
  session.cpu = new CpuController(CPU_SKILLS[settings.cpuSkill], randomSeed());
  session.startAt = performance.now() + START_COUNTDOWN_MS;
  paused = false;
  acc = 0;
  youFx.reset();
  oppFx.reset();
  keyboard.reset();
  audio.startMusic();
  overlayKey = '';
  hideOverlay();
}

/** Vs CPU: show 3-2-1 before each round, then get out of the way. */
function updateCpuCountdown(s: Extract<Session, { kind: 'cpu' }>, now: number): void {
  if (s.match.state !== 'playing' || paused) return;
  if (now < s.startAt) {
    setOverlayState('countdown', String(Math.ceil((s.startAt - now) / 1000)), s.match.round > 1 ? `Round ${s.match.round}` : 'vs CPU', []);
  } else if (overlayKey === 'countdown') {
    overlayKey = '';
    hideOverlay();
  }
}

/** Scale your board to fill the window height, leaving room for the HUD (and the CPU's board). */
function sizeCanvases(): void {
  const { width, height } = boardPixelSize(8, 16);
  const vs = session?.kind === 'cpu' || session?.kind === 'online';
  const narrow = window.innerWidth <= 520;
  const availW = window.innerWidth - (narrow ? 32 : 260) - (vs ? 40 : 0);
  // Leave room for the page padding, and in versus for the opponent's name above their bottle.
  const availH = window.innerHeight - (narrow ? 120 : 56) - (vs ? 32 : 0);
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
    rumble.forEvent(e);
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
  rumble.roundEnd(game.phase === 'won');
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
  if (match.roundWinner !== null) {
    audio.jingle(match.roundWinner === 0 ? 'win' : 'lose');
    rumble.roundEnd(match.roundWinner === 0);
  }

  if (match.state === 'matchOver') {
    const title = match.matchWinner === 0 ? 'You win the match!' : 'The CPU wins';
    showOverlay(title, `${why}. ${score}`, [['Play again', startCpuMatch], ['Menu', showMenu]]);
  } else {
    const title =
      match.roundWinner === 0 ? `You take round ${match.round}` :
      match.roundWinner === 1 ? `CPU takes round ${match.round}` :
      'Draw!';
    showOverlay(title, match.roundWinner === null ? score : `${why}. ${score}`, [['Next round', nextRound], ['Menu', showMenu]]);
  }
}

function togglePause(): void {
  if (session?.kind === 'online') {
    // Shared pause: the server tells both players; resuming has a countdown.
    const hold = onlineHold(session, performance.now());
    if (hold === null || hold === 'countdown' || hold === 'paused') room.send({ t: 'pause', paused: !session.pausedBy });
    return;
  }
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
    audio.play('warning', 0, 0); rumble.warning();
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
  if (session.kind === 'solo' || session.kind === 'online') {
    const g = session.game;
    g.step(SIM_STEP_MS, input);
    const events = g.drainEvents();
    handleYourEvents(events);
    youFx.onEvents(events);
    if (session.kind === 'online') {
      for (const e of events) {
        if (e.type === 'garbageOut') {
          room.send({ t: 'garbage', colors: e.colors });
          oppFx.markIncoming();
        }
      }
    }
    if (g.isOver) (session.kind === 'solo' ? onSoloOver : onOnlineOver)(g);
  } else {
    const { match, cpu } = session;
    const [mine, theirs] = match.step(SIM_STEP_MS, [input, cpu.poll(match.games[1], SIM_STEP_MS)]);
    handleYourEvents(mine);
    youFx.onEvents(mine);
    oppFx.onEvents(theirs);
    // Warn the moment garbage is sent, not just when it starts falling.
    if (theirs.some(e => e.type === 'garbageOut')) {
      youFx.markIncoming();
      audio.play('warning', 0, 0); rumble.warning();
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
  pad.poll();

  if (session?.kind === 'online') updateOnline(session, now);
  if (session?.kind === 'cpu') updateCpuCountdown(session, now);

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
    // Boards are hidden while paused, so nobody can plan ahead during a pause.
    const hidden = paused || (session.kind === 'online' && session.pausedBy !== null);
    applyShake(canvas, youFx, now);
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    if (!hidden) drawBoard(ctx, gameView(me, youFx), 0, 0, now);
    setText('#hud-germs', String(me.germsLeft));
    if (session.kind === 'online') {
      const snap = session.opp.snap;
      oppCtx.clearRect(0, 0, oppCanvas.width, oppCanvas.height);
      if (snap && !hidden) drawBoard(oppCtx, snapshotView(snap, oppFx.incomingFresh), 0, 0, now);
      setText('#hud-opp-germs', snap ? String(snap.g) : '–');
      const wins = session.result?.wins ?? session.info.wins;
      renderPips('#pips-you', wins[room.me] ?? 0);
      renderPips('#pips-opp', wins[session.opponentId] ?? 0);
    }
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
// A shared link (/r/ABCD) goes straight into that room's lobby.
const linkedRoom = /^\/r\/([^/]+)\/?$/.exec(location.pathname);
if (linkedRoom) {
  const code = normalizeRoomCode(linkedRoom[1]);
  settings.mode = 'online';
  if (code) room.enter(code);
  else {
    history.replaceState(null, '', '/');
    showMenu();
    $('#menu-error').textContent = "That room link doesn't look right.";
  }
}
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
