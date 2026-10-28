import { audio, VolumeKind } from './audio/audio';
import {
  BOARD_SNAPSHOT_HZ, CPU_SKILLS, CpuSkillName, ENDGAME_GERMS, ENDGAME_MUSIC_BOOST, MAX_FRAME_MS, MAX_LEVEL, MUSIC_MAX_RATE,
  MUSIC_SPEEDUP_PER_STEP, OPPONENT_BOARD_SCALE, ROUND_END_LINGER_MS, SIM_STEP_MS,
} from './config';
import { CpuController } from './core/ai';
import { Game, GameEvent } from './core/game';
import { Match } from './core/match';
import { randomSeed } from './core/rng';
import { garbageTargets } from './core/targeting';
import { Color, COLORS } from './core/types';
import { GamepadInput, NavDir } from './input/gamepad';
import { KeyboardInput } from './input/keyboard';
import { LocalSeat, LocalSetup, CPU_NAMES, deviceLabel, seatNames } from './ui/local';
import { Rumble } from './input/rumble';
import { boardPixelSize, drawBoard, drawGerm } from './render/draw';
import { BoardEffects } from './render/effects';
import { gameView } from './render/view';
import {
  BoardSnapshot, EMOTES, makeRoomCode, normalizeRoomCode, RoundResult, START_COUNTDOWN_MS, StartInfo,
} from './net/protocol';
import { CpuRunner } from './net/cpus';
import { encodeSnapshot, snapshotView } from './net/snapshot';
import { VoiceChat } from './net/voice';
import { ChatBox, isTyping, popEmote } from './ui/chat';
import { $, loadSettings, saveSettings, Settings, SKILL_LABEL, SPEED_LABEL } from './ui/dom';
import { PlayersHud } from './ui/hud';
import { ChatMessage, MatchMessage, OnlineRoom } from './ui/lobby';
import { OpponentBoards } from './ui/opponents';
import { ScreenKeyboard } from './ui/osk';
import { blurUnlessPad, focusables, moveFocus, stepRange, usingPad } from './ui/padnav';
import { VoiceBar } from './ui/voice';

const canvas = $<HTMLCanvasElement>('#board');
const ctx = canvas.getContext('2d')!;
const opponents = new OpponentBoards($('#opponents'));
const hud = new PlayersHud($('#hud-rounds'), $('#hud-germ-list'));
const keyboard = new KeyboardInput();
keyboard.attach();

// --- Game controller (e.g. PS5): feeds the same input as the keyboard, plus rumble ---

const pad = new GamepadInput(keyboard, {
  onPause: () => togglePause(),
  onConfirm: (button, index) => padConfirm(button, index),
  onBack: () => padBack(),
  onMute: () => voice.toggleMute(),
  onNavigate: dir => padNavigate(dir),
  onChange: () => renderPadUi(),
});
const rumble = new Rumble(pad);
const rumbleButton = $<HTMLButtonElement>('#toggle-rumble');
rumbleButton.addEventListener('click', () => { rumble.toggle(); renderPadUi(); blurUnlessPad(rumbleButton); });
function renderPadUi(): void {
  const connected = pad.connected;
  rumbleButton.classList.toggle('hidden', !connected);
  rumbleButton.textContent = '🎮 Rumble';
  rumbleButton.classList.toggle('off', !rumble.on);
  $('#pad-hint').classList.toggle('hidden', !connected);
}
const youFx = new BoardEffects();

/** A seat in a match on this computer: a person with their own input, or a CPU. */
type Seat =
  | { kind: 'person'; input: KeyboardInput; rumble: Rumble }
  | { kind: 'cpu'; ai: CpuController; skill: CpuSkillName };

/** What's being played right now. */
type Session =
  | { kind: 'solo'; game: Game }
  // Vs CPU and local matches. startAt = end of the 3-2-1 countdown before each round.
  | { kind: 'cpu'; match: Match; seats: Seat[]; startAt: number; local: boolean }
  | OnlineSession;

/** An opponent in an online round: their latest board snapshot and whether they're knocked out. */
interface OnlineOpponent {
  id: string;
  name: string;
  /** A CPU that this browser plays (its board comes from our worker, not the server). */
  mine: boolean;
  snap: BoardSnapshot | null;
  /** When we last heard from them. */
  at: number;
  out: boolean;
}

/** An online round: your board runs here; the opponents' (1–3) arrive as snapshots. */
interface OnlineSession {
  kind: 'online';
  game: Game;
  info: StartInfo;
  /** Opponents in seating order. */
  opps: OnlineOpponent[];
  /** Play (re)starts at this time: after the start countdown, a pause or a reconnect. */
  startAt: number;
  /** Shared pause: who paused (null if not paused). */
  pausedBy: string | null;
  /** An opponent's connection dropped: they have until `until` to come back. */
  away: { name: string; until: number } | null;
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
  if (staleOpponent(s, now)) return 'stale';
  if (now < s.startAt) return 'countdown';
  return null;
}

/**
 * The CPUs this browser plays wait while the round is held for everyone (paused, someone away
 * or quiet, round decided), but keep playing if your own board is over.
 */
function cpuHold(s: OnlineSession, now: number): boolean {
  return !!s.result || !room.connected || !!s.away || !!s.pausedBy || !!staleOpponent(s, now);
}

/** An opponent still in the round that we haven't heard from for a while (null if none). */
function staleOpponent(s: OnlineSession, now: number): OnlineOpponent | null {
  return s.opps.find(o => !o.out && now - o.at > STALE_MS) ?? null;
}

// --- CPU players in online rooms: each browser plays the ones the server gives it ---

const cpuRunner = new CpuRunner({
  onBoard: (id, snap) => {
    if (session?.kind !== 'online') return;
    const opp = session.opps.find(o => o.id === id);
    if (opp) { opp.snap = snap; opp.at = performance.now(); }
    room.send({ t: 'board', snap, as: id });
  },
  onGarbage: (id, colors, firstColors) => {
    if (session?.kind !== 'online' || session.result) return;
    room.send({ t: 'garbage', colors, firstColors, as: id });
    blinkTargets(session, id, firstColors);
  },
  onOver: (id, outcome) => {
    if (session?.kind === 'online') room.send({ t: 'result', outcome, as: id });
  },
});

// --- Online room (lobby screen + connection) ---

const room = new OnlineRoom(settings, {
  onStart: startOnline,
  onMatchMessage: onMatchMessage,
  onChat: onChat,
  onLobby: lobby => {
    voice.sync(lobby.players);
    voiceBar.setPlayers(lobby.players);
  },
  onRtc: (from, data) => void voice.onSignal(from, data),
  inMatch: () => session?.kind === 'online',
  onLeave: error => {
    voice.leave();
    cpuRunner.stop();
    showMenu();
    $('#menu-error').textContent = error ?? '';
  },
});

// --- Chat and emotes: docked at the side in online rooms; typing and emotes only outside of play ---

const chat = new ChatBox(room.me, msg => room.send(msg), () => { if (session) sizeCanvases(); });
const lobbyScreen = $('#lobby');

// Voice: direct audio between the players, set up through the room server.
const voice = new VoiceChat(room.me, msg => room.send(msg), () => {
  voiceBar.render();
  chat.setTabIcon(voiceBar.tabIcon);
});
const voiceBar = new VoiceBar(chat.voiceSlot, voice, room.me);
voice.setVolume(audio.volume.voice);
audio.onChange(() => voice.setVolume(audio.volume.voice));
window.addEventListener('keydown', e => {
  if (e.code === 'KeyV' && !e.repeat && !isTyping(e) && voice.status === 'on') voice.toggleMute();
});
const overlayEl = $('#overlay');

function onChat(msg: ChatMessage): void {
  if (msg.t === 'chatLog') return chat.setHistory(msg.lines);
  if (msg.t === 'chat') {
    chat.add(msg);
    if (msg.from !== room.me) audio.play('move');
    return;
  }
  const target = emoteTarget(msg.from);
  if (target) popEmote(target, msg.e, msg.from === room.me ? 'You' : msg.name);
}

/** Where a player's emote pops up: over the lobby, or over their bottle. */
function emoteTarget(id: string): HTMLElement | null {
  if (!lobbyScreen.classList.contains('hidden')) return $('.lobby-panel');
  if (session?.kind !== 'online') return null;
  if (id === room.me) return $('.stage');
  const k = session.opps.findIndex(o => o.id === id);
  return k >= 0 ? opponents.element(k) ?? null : null;
}

/**
 * Every frame: the chat shows in the lobby and during online matches. You can type and send
 * emotes in the lobby, while paused and on the result screens, but not while anyone's playing.
 */
function updateChat(): void {
  const inLobby = !lobbyScreen.classList.contains('hidden');
  const online = session?.kind === 'online';
  chat.show(inLobby || online);
  chat.setEnabled(inLobby || (online && (overlayKey === 'result' || overlayKey === 'paused')
    && !overlayEl.classList.contains('hidden')));
}

// T starts typing; 1–8 send an emote.
window.addEventListener('keydown', e => {
  if (!chat.enabled || isTyping(e) || e.repeat) return;
  if (e.code === 'KeyT') {
    chat.focus();
    e.preventDefault();
    return;
  }
  const n = Number(/^Digit(\d)$/.exec(e.code)?.[1]);
  if (n >= 1 && n <= EMOTES.length) chat.emote(n - 1);
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
muteButton.addEventListener('click', () => { audio.toggleMute(); blurUnlessPad(muteButton); });
musicButton.addEventListener('click', () => { audio.toggleMusic(); blurUnlessPad(musicButton); });
window.addEventListener('keydown', e => {
  if (e.code === 'KeyM' && !e.repeat && !isTyping(e)) audio.toggleMute();
});
audio.onChange(renderAudioToggles);
renderAudioToggles();

// Volume sliders (music, sound effects, voice chat), in a panel under the audio buttons.
const volumePanel = $('#volume-panel');
const volumeInputs = [...volumePanel.querySelectorAll<HTMLInputElement>('input[data-volume]')];
function renderVolumes(): void {
  for (const input of volumeInputs) {
    const pct = Math.round(audio.volume[input.dataset.volume as VolumeKind] * 100);
    if (document.activeElement !== input) input.value = String(pct);
    (input.nextElementSibling as HTMLOutputElement).value = `${pct}%`;
  }
}
for (const input of volumeInputs) {
  input.addEventListener('input', () => audio.setVolume(input.dataset.volume as VolumeKind, Number(input.value) / 100));
  input.addEventListener('change', () => blurUnlessPad(input)); // give the arrow keys back to the game
}
const volumeButton = $<HTMLButtonElement>('#toggle-volume');
volumeButton.addEventListener('click', () => {
  volumePanel.classList.toggle('hidden');
  renderVolumes();
  if (usingPad() && !volumePanel.classList.contains('hidden')) volumeInputs[0].focus(); // straight to the sliders
  else blurUnlessPad(volumeButton);
});
document.addEventListener('pointerdown', e => {
  if (!(e.target as Element).closest('.audio-toggles')) volumePanel.classList.add('hidden');
});
audio.onChange(renderVolumes);

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
  bindSeg('cpu-count', 'cpuCount', v => Number(v), v => String(v)),
  bindSeg('fast-garbage', 'fastGarbage', v => v === 'on', v => (v ? 'on' : 'off')),
  bindSeg('outbreak', 'outbreak', v => v === 'on', v => (v ? 'on' : 'off')),
  bindLevel('level', 'level'),
  bindLevel('cpu-level', 'cpuLevel'),
];

function renderMenu(): void {
  for (const r of menuRenderers) r();
  $('#menu').classList.toggle('cpu', settings.mode === 'cpu');
  $('#menu').classList.toggle('online', settings.mode === 'online');
  $('#menu').classList.toggle('local', settings.mode === 'local');
  $('#menu').classList.toggle('multi', settings.cpuCount >= 2); // Outbreak only matters with 3+ players
  $<HTMLInputElement>('#menu-name').value = settings.name;
}

$('#start').addEventListener('click', () => (
  settings.mode === 'cpu' ? startCpuMatch() : settings.mode === 'local' ? localSetup.show() : startSolo(settings.level)
));

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
  cpuRunner.stop();
  routePads(null);
  localSetup.hide();
  keyboard.enabled = false;
  audio.stopMusic();
  hideOverlay();
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
  opponents.reset();
  keyboard.enabled = true;
  resetInputs();
  audio.startMusic();
  hideOverlay();
  $('#menu').classList.add('hidden');
  $('#lobby').classList.add('hidden');
  localSetup.hide();
  $('#play').classList.remove('hidden');
  $('#play').classList.toggle('vs', session?.kind === 'cpu' || session?.kind === 'online');
  $('#play').classList.toggle('online', session?.kind === 'online');
  $('#play').classList.toggle('local', session?.kind === 'cpu' && session.local);
  const me = you();
  $('#hud-level').textContent = String(me?.level ?? settings.level);
  $('#hud-speed').textContent = SPEED_LABEL[me?.speed ?? settings.speed];
  lastMusicRate = 1; // startMusic() above reset the tempo
  sizeCanvases();
}

function startSolo(level: number): void {
  settings.level = level;
  saveSettings(settings);
  session = { kind: 'solo', game: new Game({ level, speed: settings.speed, seed: randomSeed(), playerSalt: 'solo' }) };
  routePads(null);
  setupPlayers(['You'], []);
  enterPlay();
}

function newCpu(skill: CpuSkillName): Seat {
  return { kind: 'cpu', ai: new CpuController(CPU_SKILLS[skill], randomSeed()), skill };
}

/**
 * Where controllers' game buttons go: everyone drives the one player (null), or in a local
 * match each controller drives its own seat (and controllers nobody joined with do nothing).
 */
function routePads(pads: Map<number, KeyboardInput> | null): void {
  pad.route = pads ? i => pads.get(i) ?? null : () => keyboard;
}

/** Everyone's input on this computer (the keyboard, plus each local player's controller). */
function personInputs(): KeyboardInput[] {
  if (session?.kind !== 'cpu') return [keyboard];
  return session.seats.flatMap(s => (s.kind === 'person' ? [s.input] : []));
}

/** Forget held buttons (new round, pause): nobody's capsule moves from a button held over. */
function resetInputs(): void {
  for (const input of personInputs()) input.reset();
}

function startCpuMatch(): void {
  const count = settings.cpuCount;
  const match = new Match({
    players: [
      { level: settings.level, speed: settings.speed },
      ...Array.from({ length: count }, () => ({ level: settings.cpuLevel, speed: settings.cpuSpeed })),
    ],
    seed: randomSeed(),
    fastGarbage: settings.fastGarbage,
    outbreak: settings.outbreak && count >= 2,
  });
  session = {
    kind: 'cpu', match, local: false, startAt: performance.now() + START_COUNTDOWN_MS,
    seats: [{ kind: 'person', input: keyboard, rumble }, ...Array.from({ length: count }, () => newCpu(settings.cpuSkill))],
  };
  routePads(null);
  overlayKey = '';
  const names = count === 1 ? ['CPU'] : CPU_NAMES.slice(0, count);
  const detail = `${SKILL_LABEL[settings.cpuSkill]} · Lv ${settings.cpuLevel}`;
  setupPlayers(['You', ...names], names.map(n => (count === 1 ? `CPU · ${detail}` : `${n} · ${detail}`)));
  $('#hud-fast').classList.toggle('hidden', !settings.fastGarbage);
  $('#hud-outbreak').classList.toggle('hidden', !(settings.outbreak && count >= 2));
  enterPlay();
}

// --- Local matches: several people on this screen (controllers, the keyboard) and CPUs ---

const localSetup = new LocalSetup(settings, { onStart: startLocal, onBack: showMenu });
/** The connected controllers last shown on the setup screen. */
let shownPads = '';
function updateLocalPads(): void {
  if (!localSetup.visible) return void (shownPads = '');
  const list = pad.list();
  const key = JSON.stringify(list);
  if (key !== shownPads) {
    shownPads = key;
    localSetup.setPads(list);
  }
}
/** The last local lineup, for "Play again". */
let lastLocal: LocalSeat[] = [];

function startLocal(lineup: LocalSeat[]): void {
  lastLocal = lineup;
  const names = seatNames(lineup);
  const match = new Match({
    players: lineup.map(s => ({ level: s.level, speed: s.speed })),
    seed: randomSeed(),
    fastGarbage: settings.fastGarbage,
    outbreak: settings.outbreak && lineup.length >= 3,
  });
  const pads = new Map<number, KeyboardInput>();
  const seats: Seat[] = lineup.map(s => {
    if (s.kind === 'cpu') return newCpu(s.skill);
    if (s.device === 'keyboard') return { kind: 'person', input: keyboard, rumble: rumble.forPad(-1) };
    const input = new KeyboardInput(); // fed by that controller only
    input.enabled = true;
    pads.set(s.device, input);
    return { kind: 'person', input, rumble: rumble.forPad(s.device) };
  });
  session = { kind: 'cpu', match, seats, local: true, startAt: performance.now() + START_COUNTDOWN_MS };
  routePads(pads);
  overlayKey = '';
  const label = (s: LocalSeat, i: number) => `${names[i]} · ${deviceLabel(s)} · Lv ${s.level} · ${SPEED_LABEL[s.speed]}`;
  setupPlayers(names, lineup.slice(1).map((s, k) => label(s, k + 1)));
  $('#board-label').textContent = label(lineup[0], 0);
  $('#hud-fast').classList.toggle('hidden', !settings.fastGarbage);
  $('#hud-outbreak').classList.toggle('hidden', !(settings.outbreak && lineup.length >= 3));
  enterPlay();
}

/** Side panel rows (you first) and one labelled bottle per opponent. */
function setupPlayers(names: string[], boardLabels: string[]): void {
  hud.setPlayers(names);
  opponents.setup(boardLabels);
}

/** A round starts (the first from the lobby, later ones automatically): your board on the shared seed. */
function startOnline(info: StartInfo): void {
  const me = info.players.find(p => p.id === room.me);
  const others = info.players.filter(p => p.id !== room.me);
  if (!me || others.length === 0) return;
  routePads(null);
  const now = performance.now();
  session = {
    kind: 'online',
    game: new Game({ level: me.level, speed: me.speed, seed: info.seed, fastGarbage: info.settings.fastGarbage, playerSalt: me.id }),
    info,
    opps: others.map(p => ({ id: p.id, name: p.name, mine: p.runBy === room.me, snap: null, at: now, out: false })),
    startAt: now + info.startInMs,
    pausedBy: null,
    away: null,
    result: null,
    resultSent: false,
    lastSent: { json: '', at: 0 },
  };
  setupPlayers(['You', ...others.map(p => p.name)], others.map(p =>
    `${p.name}${p.cpu ? ` (CPU ${SKILL_LABEL[p.cpu]})` : ''} · Lv ${p.level} · ${SPEED_LABEL[p.speed]}`));
  // The CPUs this browser plays this round.
  cpuRunner.start(info.players.filter(p => p.cpu && p.runBy === room.me).map(p => ({
    id: p.id, level: p.level, speed: p.speed, skill: p.cpu!, seed: info.seed, aiSeed: randomSeed(), fastGarbage: info.settings.fastGarbage,
  })), session.startAt);
  $('#hud-fast').classList.toggle('hidden', !info.settings.fastGarbage);
  $('#hud-outbreak').classList.toggle('hidden', !(info.settings.outbreak && others.length >= 2));
  overlayKey = '';
  enterPlay();
}

/** "You" or a player's name. */
function onlineName(s: OnlineSession, id: string): string {
  return id === room.me ? 'You' : s.opps.find(o => o.id === id)?.name ?? 'Someone';
}

function onMatchMessage(msg: MatchMessage): void {
  if (session?.kind !== 'online') return;
  const s = session;
  const now = performance.now();
  const opp = 'from' in msg ? s.opps.find(o => o.id === msg.from) : undefined;
  switch (msg.t) {
    case 'board':
      if (opp) { opp.snap = msg.snap; opp.at = now; }
      break;
    case 'garbage':
      if (msg.to) {
        // For a CPU this browser plays.
        const k = s.opps.findIndex(o => o.id === msg.to && o.mine);
        if (k >= 0 && !s.result) {
          cpuRunner.garbage(msg.to, msg.colors);
          opponents.fx(k).markIncoming();
        }
        break;
      }
      // The server only sends garbage to the players it targeted.
      if (opp && !s.result) {
        s.game.receiveGarbage(msg.colors);
        youFx.markIncoming();
        audio.play('warning', 0, 0); rumble.warning();
      }
      break;
    case 'out': {
      const o = s.opps.find(x => x.id === msg.id);
      if (o) o.out = true;
      break;
    }
    case 'pause':
      s.pausedBy = msg.paused ? msg.by : null;
      if (!msg.paused) s.startAt = now + msg.resumeInMs;
      audio.setMusicPaused(msg.paused);
      keyboard.reset();
      break;
    case 'away':
      if (msg.id !== room.me) s.away = { name: msg.name, until: now + msg.graceMs };
      break;
    case 'back':
      // An opponent came back, or you did after a blip: resume after a countdown.
      if (msg.id !== room.me) s.away = null;
      s.startAt = now + msg.resumeInMs;
      for (const o of s.opps) o.at = now;
      keyboard.reset();
      break;
    case 'round':
      onOnlineRound(s, msg);
      break;
  }
}

function onOnlineRound(s: OnlineSession, r: RoundResult): void {
  s.result = r;
  cpuRunner.sync(true, s.startAt);
  hideOverlay(); // leave the boards visible for a moment before the result
  overlayKey = 'result';
  audio.stopMusic();
  if (r.winner) {
    audio.jingle(r.winner === room.me ? 'win' : 'lose');
    rumble.roundEnd(r.winner === room.me);
  }

  const who = (id: string) => onlineName(s, id);
  const mine = r.by === room.me;
  const why =
    r.reason === 'cleared' ? `${who(r.by)} cleared ${mine ? 'your' : 'their'} bottle` :
    r.reason === 'toppedOut' ? `${who(r.by)} topped out` :
    r.reason === 'forfeit' ? `${who(r.by)} left the round` :
    r.reason === 'lastStanding' ? (mine ? "You're the last one standing" : `${who(r.by)} is the last one standing`) :
    `${who(r.by)} disconnected`;
  const score = s.opps.length === 1
    ? `You ${r.wins[room.me] ?? 0} – ${r.wins[s.opps[0].id] ?? 0} ${s.opps[0].name}`
    : [room.me, ...s.opps.map(o => o.id)].map(id => `${who(id)} ${r.wins[id] ?? 0}`).join(' · ');
  const iWon = r.winner === room.me;
  const winnerName = r.winner ? who(r.winner) : '';
  if (r.matchOver) {
    showOverlayLater(ROUND_END_LINGER_MS, iWon ? 'You win the match!' : r.winner ? `${winnerName} wins the match` : 'Match over', `${why}. ${score}`, [
      ['Play again', () => playAgainOnline(s)],
      ['Back to lobby', leaveOnlineMatch],
      ['Leave room', () => room.leave()],
    ]);
  } else {
    const round = s.info.round;
    const title = !r.winner ? 'Draw!' : iWon ? `You take round ${round}` : `${winnerName} takes round ${round}`;
    showOverlayLater(ROUND_END_LINGER_MS, title, `${why}. ${score}. Next round coming up…`, []);
  }
}

/** Ready for another match with the same settings; it starts once everyone agrees. */
function playAgainOnline(s: OnlineSession): void {
  room.send({ t: 'playAgain' });
  const waitingFor = s.opps.length === 1 ? s.opps[0].name : 'the others';
  showOverlay('Play again', `Waiting for ${waitingFor}…`, [['Back to lobby', leaveOnlineMatch]]);
}

function leaveOnlineMatch(): void {
  session = null;
  cpuRunner.stop();
  keyboard.enabled = false;
  audio.stopMusic();
  room.backToLobby();
}

/**
 * Blink the incoming preview of whoever a chain's garbage goes to. The server picks the
 * targets; this works out the same ones just for the effect.
 */
function blinkTargets(s: OnlineSession, from: string, firstColors: Color[]): void {
  const seats = s.info.players.map(p => p.id);
  const alive = seats.map(id => (id === room.me ? s.game.phase !== 'lost' : !s.opps.find(o => o.id === id)?.out));
  for (const t of garbageTargets(seats.indexOf(from), alive, firstColors, s.info.settings.outbreak)) {
    if (seats[t] === room.me) continue; // your own warning comes with the garbage itself
    const k = s.opps.findIndex(o => o.id === seats[t]);
    if (k >= 0) opponents.fx(k).markIncoming();
  }
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
  if (session?.kind !== 'online') return;
  const now = performance.now();
  sendBoard(session, now);
  cpuRunner.sync(cpuHold(session, now), session.startAt);
}, SNAPSHOT_KEEPALIVE_MS);

/** Once per frame during an online round: send your board, and show the right overlay. */
function updateOnline(s: OnlineSession, now: number): void {
  sendBoard(s, now);
  cpuRunner.sync(cpuHold(s, now), s.startAt);

  const hold = onlineHold(s, now);
  if (hold === 'result') return; // result overlay is already up
  const secs = (t: number) => String(Math.max(0, Math.ceil((t - now) / 1000)));
  switch (hold) {
    case 'over':
      if (s.game.phase === 'lost' && s.opps.filter(o => !o.out).length > 1) {
        return setOverlayState('over', "You're out", 'Watching the others finish the round…', []);
      }
      return setOverlayState('over', s.game.phase === 'won' ? 'Bottle clean!' : 'Topped out', 'Waiting for the result…', []);
    case 'reconnecting':
      return setOverlayState('reconnecting', 'Reconnecting…', 'Your connection dropped. Hang on…', []);
    case 'away':
      return setOverlayState('away', `${s.away!.name} disconnected`, `${s.away!.name} has ${secs(s.away!.until)} s to come back`, []);
    case 'paused':
      return setOverlayState('paused', 'Paused', `Paused by ${s.pausedBy}. Anyone can resume.`, [
        ['Resume', () => room.send({ t: 'pause', paused: false })],
        ['Leave room', () => room.leave()],
      ]);
    case 'stale':
      return setOverlayState('stale', 'Connection problem…', `Waiting to hear from ${staleOpponent(s, now)?.name ?? 'the others'}`, []);
    case 'countdown': {
      const vs = s.opps.length === 1 ? `vs ${s.opps[0].name}` : `vs ${s.opps.map(o => o.name).join(', ')}`;
      return setOverlayState('countdown', secs(s.startAt), s.info.round > 1 ? `Round ${s.info.round}` : vs, []);
    }
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
  session.seats = session.seats.map(s => (s.kind === 'cpu' ? newCpu(s.skill) : s));
  session.startAt = performance.now() + START_COUNTDOWN_MS;
  paused = false;
  acc = 0;
  youFx.reset();
  opponents.reset();
  resetInputs();
  audio.startMusic();
  lastMusicRate = 1;
  $('#hud-speed').textContent = SPEED_LABEL[settings.speed];
  overlayKey = '';
  hideOverlay();
}

/** Vs CPU: show 3-2-1 before each round, then get out of the way. */
function updateCpuCountdown(s: Extract<Session, { kind: 'cpu' }>, now: number): void {
  if (s.match.state !== 'playing' || paused) return;
  if (now < s.startAt) {
    const n = s.seats.length - 1;
    const vs = s.local ? hud.playerNames.join(' vs ') : n === 1 ? 'vs CPU' : `vs ${n} CPUs`;
    setOverlayState('countdown', String(Math.ceil((s.startAt - now) / 1000)), s.match.round > 1 ? `Round ${s.match.round}` : vs, []);
  } else if (overlayKey === 'countdown') {
    overlayKey = '';
    hideOverlay();
  }
}

/**
 * Scale your board to fill the window height, leaving room for the HUD and the opponents'
 * bottles (full size against one opponent, smaller against two or three).
 */
function sizeCanvases(): void {
  const { width, height } = boardPixelSize(8, 16);
  const n = opponents.count;
  // Local matches: everyone's bottle is the same size.
  const local = session?.kind === 'cpu' && session.local;
  const oppScale = n <= 1 || local ? OPPONENT_BOARD_SCALE : n === 2 ? 0.6 : 0.5;
  const narrow = window.innerWidth <= 520;
  const availW = window.innerWidth - (narrow ? 32 : 260) - n * 32 - chat.reservedWidth;
  // Leave room for the page padding, and in versus for the opponents' names under their bottles.
  const availH = window.innerHeight - (narrow ? 120 : 56) - (n ? 32 : 0);
  // The canvases stay at sprite resolution; CSS scales them up with crisp (pixelated) edges.
  // Whole-number scales keep every pixel the same size, so prefer one when it's close.
  const fit = Math.max(1, Math.min(availW / (width * (1 + n * oppScale)), availH / height));
  const scale = fit - Math.floor(fit) < 0.35 ? Math.floor(fit) : fit;
  canvas.width = width;
  canvas.height = height;
  canvas.style.width = `${Math.round(width * scale)}px`;
  canvas.style.height = `${Math.round(height * scale)}px`;
  ctx.imageSmoothingEnabled = false;
  opponents.size(scale * oppScale);
}
window.addEventListener('resize', () => { if (session) sizeCanvases(); });

// --- Events and results ---

/** A person's board events on this computer: sounds, their rumble, and their input's per-capsule reset. */
function handleYourEvents(events: GameEvent[], input = keyboard, rum = rumble): void {
  for (const e of events) {
    playSound(e);
    rum.forEvent(e);
    if (e.type === 'spawn') input.onNewCapsule();
    if (e.type === 'speedUp') {
      audio.jingle('speedUp');
      flashSpeed(e.step);
    }
  }
}

/** The Speed label flashes and shows how many speed-ups so far ("Med ▲2"). */
function flashSpeed(step: number): void {
  const me = you();
  const el = $('#hud-speed');
  el.textContent = `${SPEED_LABEL[me?.speed ?? settings.speed]} ▲${step}`;
  el.classList.remove('flash');
  void el.offsetWidth; // restart the animation
  el.classList.add('flash');
}

/**
 * Music tempo follows the game: a bit faster with every speed-up, and an extra push once any
 * board in play is down to its last few germs. Called every frame; only changes when needed.
 */
let lastMusicRate = 1;
function updateMusicRate(): void {
  const me = you();
  if (!me || !session) return;
  const others =
    session.kind === 'cpu' ? session.match.games.slice(1).filter(g => g.phase !== 'lost').map(g => g.germsLeft) :
    session.kind === 'online' ? session.opps.filter(o => !o.out && o.snap).map(o => o.snap!.g) : [];
  const endgame = [me.germsLeft, ...others].some(g => g > 0 && g <= ENDGAME_GERMS);
  const rate = Math.min(MUSIC_MAX_RATE, 1 + MUSIC_SPEEDUP_PER_STEP * me.speedStep) + (endgame ? ENDGAME_MUSIC_BOOST : 0);
  if (Math.abs(rate - lastMusicRate) > 0.001) {
    lastMusicRate = rate;
    audio.setMusicRate(rate);
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
    showOverlayLater(ROUND_END_LINGER_MS, 'Bottle clean!', `Level ${lvl} cleared`, buttons);
  } else {
    audio.jingle('lose');
    showOverlayLater(ROUND_END_LINGER_MS, 'Topped out', `${game.germsLeft} germs left`, [['Retry', () => startSolo(lvl)], ['Menu', showMenu]]);
  }
}

function onRoundOver(match: Match): void {
  audio.stopMusic();
  if (session?.kind === 'cpu' && session.local) return onLocalRoundOver(match, session.seats);
  const names = hud.playerNames;
  const n = match.playerCount;
  /** "You", "The CPU" (one opponent) or the CPU's name. */
  const who = (i: number) => (i === 0 ? 'You' : n === 2 ? 'The CPU' : names[i]);
  const w = match.roundWinner;
  const why =
    w === null ? 'Nobody made it' :
    match.games[w].phase === 'won' ? `${who(w)} cleared ${w === 0 ? 'your' : n === 2 ? 'its' : 'their'} bottle` :
    n === 2 ? `${who(1 - w)} topped out` :
    w === 0 ? "You're the last one standing" : `${who(w)} is the last one standing`;
  const score = n === 2
    ? `You ${match.wins[0]} – ${match.wins[1]} CPU`
    : names.map((name, i) => `${name} ${match.wins[i]}`).join(' · ');
  if (w !== null) {
    audio.jingle(w === 0 ? 'win' : 'lose');
    rumble.roundEnd(w === 0);
  }

  if (match.state === 'matchOver') {
    const mw = match.matchWinner!;
    const title = mw === 0 ? 'You win the match!' : `${who(mw)} wins the match`;
    showOverlayLater(ROUND_END_LINGER_MS, title, `${why}. ${score}`, [['Play again', startCpuMatch], ['Menu', showMenu]]);
  } else {
    const title =
      w === null ? 'Draw!' :
      w === 0 ? `You take round ${match.round}` :
      `${n === 2 ? 'CPU' : names[w]} takes round ${match.round}`;
    showOverlayLater(ROUND_END_LINGER_MS, title, w === null ? score : `${why}. ${score}`, [['Next round', nextRound], ['Menu', showMenu]]);
  }
}

/** A local match round ended: everyone on this screen is named (P1, P2, Spike…). */
function onLocalRoundOver(match: Match, seats: Seat[]): void {
  const names = hud.playerNames;
  const w = match.roundWinner;
  const why =
    w === null ? 'Nobody made it' :
    match.games[w].phase === 'won' ? `${names[w]} cleared their bottle` :
    match.playerCount === 2 ? `${names[1 - w]} topped out` :
    `${names[w]} is the last one standing`;
  const score = match.playerCount === 2
    ? `${names[0]} ${match.wins[0]} – ${match.wins[1]} ${names[1]}`
    : names.map((name, i) => `${name} ${match.wins[i]}`).join(' · ');
  if (w !== null) audio.jingle(seats[w].kind === 'person' ? 'win' : 'lose');
  seats.forEach((s, i) => { if (s.kind === 'person') s.rumble.roundEnd(i === w); });

  if (match.state === 'matchOver') {
    const mw = match.matchWinner!;
    showOverlayLater(ROUND_END_LINGER_MS, `${names[mw]} wins the match!`, `${why}. ${score}`, [
      ['Play again', () => startLocal(lastLocal)],
      ['Change players', () => { session = null; audio.stopMusic(); localSetup.show(); }],
      ['Menu', showMenu],
    ]);
  } else {
    const title = w === null ? 'Draw!' : `${names[w]} takes round ${match.round}`;
    showOverlayLater(ROUND_END_LINGER_MS, title, w === null ? score : `${why}. ${score}`, [['Next round', nextRound], ['Menu', showMenu]]);
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
  resetInputs();
  if (paused) showOverlay('Paused', 'Press P to resume', [['Resume', togglePause], ['Quit to menu', showMenu]]);
  else hideOverlay();
}

window.addEventListener('keydown', e => {
  if (!session || isTyping(e)) return;
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

// --- Getting around menus with a controller (never during play) ---

const osk = new ScreenKeyboard();

/** A menu is up: no session (title / lobby), paused, or an overlay with buttons (between rounds). */
function menuActive(): boolean {
  if (!session || paused) return true;
  if (session.kind === 'online' && session.pausedBy) return true;
  return !overlayEl.classList.contains('hidden') && document.querySelector('#overlay-buttons button') !== null;
}

/** Where the selection starts when nothing is selected yet. */
function defaultControl(list: HTMLElement[]): HTMLElement | undefined {
  for (const sel of ['.osk button', '#overlay-buttons button', '#ready-btn', '#local-start', '#start', '#create-room']) {
    const el = list.find(e => e.matches(sel));
    if (el) return el;
  }
  return list[0];
}

function padNavigate(dir: NavDir): void {
  if (!menuActive()) return;
  document.body.classList.add('pad-nav');
  const list = osk.isOpen ? focusables(osk.panel) : focusables();
  const cur = document.activeElement as HTMLElement | null;
  if (!cur || !list.includes(cur)) {
    defaultControl(list)?.focus();
    return;
  }
  if (cur instanceof HTMLInputElement && cur.type === 'range' && (dir === 'left' || dir === 'right')) {
    stepRange(cur, dir === 'right' ? 1 : -1);
    return;
  }
  if (moveFocus(list, dir)) audio.play('move');
  // Left the volume panel: close it.
  if (!volumePanel.classList.contains('hidden') && !document.activeElement?.closest('.audio-toggles')) {
    volumePanel.classList.add('hidden');
  }
}

function padConfirm(button: 'cross' | 'options', index: number): boolean {
  if (!menuActive()) return false;
  // Local match setup: ✕ on a controller that hasn't joined yet joins with it.
  if (button === 'cross' && localSetup.joinPad(index)) {
    audio.play('rotate');
    return true;
  }
  document.body.classList.add('pad-nav');
  if (osk.isOpen && button === 'options') {
    osk.done();
    return true;
  }
  const el = document.activeElement;
  if (!(el instanceof HTMLElement) || el.getClientRects().length === 0) return false;
  if (el instanceof HTMLInputElement && el.type === 'text' && !el.closest('.chat-form')) {
    osk.open(el);
    return true;
  }
  if (el instanceof HTMLButtonElement && !el.disabled) {
    el.click();
    return true;
  }
  return false;
}

function padBack(): void {
  if (!menuActive()) return;
  if (osk.isOpen) return osk.backspace();
  if (!volumePanel.classList.contains('hidden')) {
    volumePanel.classList.add('hidden');
    volumeButton.focus();
  }
}

// Mouse or keyboard: stop marking the controller's selection.
for (const type of ['pointerdown', 'keydown']) {
  window.addEventListener(type, () => document.body.classList.remove('pad-nav'), { capture: true });
}

// --- Overlay ---

/** Move focus between the overlay's buttons (keyboard ↑/↓, controller D-pad / stick). */
function navigateOverlay(dir: -1 | 1): boolean {
  if (running() || overlayEl.classList.contains('hidden')) return false;
  const buttons = [...document.querySelectorAll<HTMLButtonElement>('#overlay-buttons button')].filter(b => !b.disabled);
  if (buttons.length === 0) return false;
  const i = buttons.indexOf(document.activeElement as HTMLButtonElement);
  const next = i < 0 ? (dir > 0 ? 0 : buttons.length - 1) : (i + dir + buttons.length) % buttons.length;
  buttons[next].focus();
  if (next !== i) audio.play('move');
  return true;
}

window.addEventListener('keydown', e => {
  if (isTyping(e) || overlayEl.classList.contains('hidden') || running()) return;
  if (e.code === 'ArrowUp' || e.code === 'ArrowDown') {
    if (navigateOverlay(e.code === 'ArrowUp' ? -1 : 1)) e.preventDefault();
  } else if ((e.code === 'Enter' || e.code === 'Space') && !e.repeat) {
    // Space would normally click on release, but the game keeps Space for itself.
    const el = document.activeElement;
    if (el instanceof HTMLButtonElement && el.closest('#overlay-buttons')) {
      e.preventDefault();
      el.click();
    }
  }
});

let overlayTimer: ReturnType<typeof setTimeout> | undefined;

/** Show an overlay after a delay (e.g. so the boards stay visible for a moment after a round). */
function showOverlayLater(ms: number, title: string, sub: string, buttons: [string, () => void][]): void {
  clearTimeout(overlayTimer);
  overlayTimer = setTimeout(() => showOverlay(title, sub, buttons), ms);
}

function showOverlay(title: string, sub: string, buttons: [string, () => void][]): void {
  clearTimeout(overlayTimer);
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
  clearTimeout(overlayTimer);
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

// --- Loop: fixed-step simulation on the real clock, render every frame ---

function step(): void {
  if (!session) return;
  if (session.kind === 'solo' || session.kind === 'online') {
    const g = session.game;
    g.step(SIM_STEP_MS, keyboard.poll(SIM_STEP_MS));
    const events = g.drainEvents();
    handleYourEvents(events);
    youFx.onEvents(events);
    if (session.kind === 'online') {
      for (const e of events) {
        if (e.type !== 'garbageOut') continue;
        room.send({ t: 'garbage', colors: e.colors, firstColors: e.firstColors });
        blinkTargets(session, room.me, e.firstColors);
      }
    }
    if (g.isOver) (session.kind === 'solo' ? onSoloOver : onOnlineOver)(g);
  } else {
    const { match, seats } = session;
    const inputs = seats.map((s, k) => (s.kind === 'cpu' ? s.ai.poll(match.games[k], SIM_STEP_MS) : s.input.poll(SIM_STEP_MS)));
    const events = match.step(SIM_STEP_MS, inputs);
    seats.forEach((s, k) => { if (s.kind === 'person') handleYourEvents(events[k], s.input, s.rumble); });
    youFx.onEvents(events[0]);
    events.slice(1).forEach((list, k) => opponents.fx(k).onEvents(list));
    // Warn the moment garbage is sent to a person here, not just when it starts falling.
    for (const d of match.deliveries) {
      (d.to === 0 ? youFx : opponents.fx(d.to - 1)).markIncoming();
      const s = seats[d.to];
      if (s.kind === 'person') { audio.play('warning', 0, 0); s.rumble.warning(); }
    }
    if (match.state !== 'playing') onRoundOver(match);
  }
}

/** Side panel: everyone's round stars and germ counts. */
function updateHud(): void {
  if (!session) return;
  if (session.kind === 'solo') {
    hud.update([{ wins: 0, germs: session.game.germsLeft, out: false }]);
  } else if (session.kind === 'cpu') {
    const m = session.match;
    hud.update(m.games.map((g, i) => ({ wins: m.wins[i], germs: g.germsLeft, out: !m.isAlive(i) })));
  } else {
    const wins = session.result?.wins ?? session.info.wins;
    hud.update([
      { wins: wins[room.me] ?? 0, germs: session.game.germsLeft, out: session.game.phase === 'lost' },
      ...session.opps.map(o => ({ wins: wins[o.id] ?? 0, germs: o.snap?.g ?? null, out: o.out })),
    ]);
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
  if (session) updateMusicRate();

  if (session?.kind === 'online') updateOnline(session, now);
  if (session?.kind === 'cpu') updateCpuCountdown(session, now);
  updateChat();
  voiceBar.tick();
  updateLocalPads();

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
      opponents.update(dt);
    }
    // Boards are hidden while paused, so nobody can plan ahead during a pause.
    const hidden = paused || (session.kind === 'online' && session.pausedBy !== null);
    applyShake(canvas, youFx, now);
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    if (!hidden) drawBoard(ctx, gameView(me, youFx), 0, 0, now);
    const youOut =
      session.kind === 'cpu' ? !session.match.isAlive(0) :
      session.kind === 'online' && session.opps.length > 1 && session.game.phase === 'lost';
    $('#play').classList.toggle('you-out', youOut);
    if (session.kind === 'online') {
      session.opps.forEach((o, k) => opponents.draw(
        k, o.snap && !hidden ? snapshotView(o.snap, opponents.fx(k).incomingFresh) : null, now, o.out,
      ));
    }
    if (session.kind === 'cpu') {
      const m = session.match;
      m.games.slice(1).forEach((g, k) => opponents.draw(k, hidden ? null : gameView(g, opponents.fx(k)), now, !m.isAlive(k + 1)));
    }
    updateHud();
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
  if (params.has('cpus')) settings.cpuCount = Math.min(3, Math.max(1, Number(params.get('cpus')) || 1)); // ?cpu=5&cpus=3
  startCpuMatch();
}
// ?garbage=6 queues that many garbage pieces on your board at the start (to see the incoming preview).
if (import.meta.env.DEV && params.has('garbage')) {
  you()?.receiveGarbage(Array.from({ length: Number(params.get('garbage')) || 4 }, (_, i) => COLORS[i % 3]));
}
// For browser tests in development: look at the current session from the console.
if (import.meta.env.DEV) (window as unknown as { __session: () => Session | null }).__session = () => session;
requestAnimationFrame(frame);
