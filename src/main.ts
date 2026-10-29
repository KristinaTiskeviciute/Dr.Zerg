import { audio } from './audio/audio';
import { musicRate, playSound } from './audio/game-sounds';
import { BOARD_SNAPSHOT_HZ, CPU_SKILLS, CpuSkillName, MAX_FRAME_MS, MAX_LEVEL, ROUND_END_LINGER_MS, SIM_STEP_MS } from './config';
import { CpuController } from './core/ai';
import { Game, GameEvent } from './core/game';
import { Match } from './core/match';
import { randomSeed } from './core/rng';
import { garbageTargets } from './core/targeting';
import { Color, COLORS } from './core/types';
import { GamepadInput } from './input/gamepad';
import { KeyboardInput } from './input/keyboard';
import { Rumble } from './input/rumble';
import { CpuRunner } from './net/cpus';
import { EMOTES, makeRoomCode, normalizeRoomCode, RoundResult, START_COUNTDOWN_MS, StartInfo } from './net/protocol';
import { encodeSnapshot, snapshotView } from './net/snapshot';
import { VoiceChat } from './net/voice';
import { cpuRoundText, localRoundText, onlineRoundText } from './play/results';
import { cpuHold, CpuSession, hasGuests, OnlineGuest, onlineHold, OnlineSession, Seat, Session, staleOpponent, yourGame } from './play/session';
import { drawBoard } from './render/draw';
import { BoardEffects } from './render/effects';
import { gameView } from './render/view';
import { ChatBox, isTyping, popEmote } from './ui/chat';
import { $, loadSettings, saveSettings, Settings, SKILL_LABEL, SPEED_LABEL } from './ui/dom';
import { PlayersHud } from './ui/hud';
import { BoardLayout, LayoutOptions } from './ui/layout';
import { ChatMessage, MatchMessage, OnlineRoom } from './ui/lobby';
import { CPU_NAMES, deviceLabel, LocalSeat, LocalSetup, seatNames } from './ui/local';
import { Mascots } from './ui/mascots';
import { OpponentBoards } from './ui/opponents';
import { Overlay } from './ui/overlay';
import { PadMenus } from './ui/padmenu';
import { showToast, TopBar } from './ui/topbar';
import { TouchUi } from './ui/touch-ui';
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
  onConfirm: (button, index) => { lastPad = index; return padMenus.confirm(button, index); },
  onBack: index => { lastPad = index; padMenus.back(); },
  onMute: () => voice.toggleMute(),
  onNavigate: (dir, index) => { lastPad = index; room.notePad(index); padMenus.navigate(dir); },
  onChange: () => topBar.renderPad(),
});
const rumble = new Rumble(pad);
/** The controller last used in the menus (null once the keyboard or mouse is used): you came into a room with it. */
let lastPad: number | null = null;
for (const type of ['pointerdown', 'keydown']) window.addEventListener(type, () => { lastPad = null; }, { capture: true });
const youFx = new BoardEffects();

/** Send your board at least this often, even if nothing changed (doubles as a heartbeat). */
const SNAPSHOT_KEEPALIVE_MS = 500;

const settings: Settings = loadSettings();
let session: Session | null = null;
let paused = false;
let acc = 0;
let lastTime = performance.now();

/** Your own board in the current session. */
const you = () => yourGame(session);
/** Where opponent k's bottle is among the small ones online (your couch guests' come first). */
const oppSlot = (s: OnlineSession, k: number) => s.guests.length + k;

/** True while boards should be advancing. */
function running(): boolean {
  if (!session || paused) return false;
  switch (session.kind) {
    case 'solo': return !session.game.isOver;
    case 'cpu': return session.match.state === 'playing' && performance.now() >= session.startAt;
    case 'online': return onlineHold(session, performance.now(), room.connected) === null;
  }
}

const overlay = new Overlay(running);

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
  return k >= 0 ? opponents.element(oppSlot(session, k)) ?? null : null;
}

/**
 * Every frame: the chat shows in the lobby and during online matches. You can type and send
 * emotes in the lobby, while paused and on the result screens, but not while anyone's playing.
 */
function updateChat(): void {
  const inLobby = !lobbyScreen.classList.contains('hidden');
  const online = session?.kind === 'online';
  chat.show(inLobby || online);
  chat.setEnabled(inLobby || (online && (overlay.key === 'result' || overlay.key === 'paused') && overlay.visible));
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

// --- Audio (unlocked by the first key press or click, a browser rule), top bar, touch controls ---

window.addEventListener('keydown', () => audio.unlock(), { capture: true });
window.addEventListener('pointerdown', () => audio.unlock(), { capture: true });

const topBar = new TopBar(pad, rumble);
const touchUi = new TouchUi(settings, keyboard, canvas, { onPause: () => togglePause(), live: () => running() && touchGame() });
/**
 * A game that touch controls work in: one person on this screen (not a local match or an online
 * round with couch guests, where everyone has a controller or the keyboard).
 */
const touchGame = () => session !== null && !(session.kind === 'cpu' && session.local) && !hasGuests(session);
const layout = new BoardLayout(canvas, opponents, touchUi.pad, () => chat.reservedWidth);

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
$('#create-room').addEventListener('click', () => room.enter(makeRoomCode(), lastPad));
const joinCode = $<HTMLInputElement>('#join-code');
function joinTypedRoom(): void {
  const code = normalizeRoomCode(joinCode.value);
  if (code) room.enter(code, lastPad);
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
  overlay.hide();
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
  overlay.hide();
  $('#menu').classList.add('hidden');
  $('#lobby').classList.add('hidden');
  localSetup.hide();
  $('#play').classList.remove('hidden');
  $('#play').classList.toggle('vs', session?.kind === 'cpu' || session?.kind === 'online');
  $('#play').classList.toggle('online', session?.kind === 'online');
  // Everyone on this screen equal (local matches, and online rounds with couch guests).
  $('#play').classList.toggle('local', (session?.kind === 'cpu' && session.local) || hasGuests(session));
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
 * Where controllers' game buttons go: everyone drives the one player (null), or each listed
 * controller drives its own seat. The rest drive `others`: nobody in a local match (controllers
 * nobody joined with do nothing), you in an online round with couch guests.
 */
function routePads(pads: Map<number, KeyboardInput> | null, others: KeyboardInput | null = null): void {
  pad.route = pads ? i => pads.get(i) ?? others : () => keyboard;
}

/** Everyone's input on this computer (the keyboard, plus each local player's controller). */
function personInputs(): KeyboardInput[] {
  if (session?.kind === 'online') return [keyboard, ...session.guests.map(g => g.input)];
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
  overlay.key = '';
  const names = count === 1 ? ['CPU'] : CPU_NAMES.slice(0, count);
  const detail = `${SKILL_LABEL[settings.cpuSkill]} · Lv ${settings.cpuLevel}`;
  setupPlayers(['You', ...names], names.map(n => (count === 1 ? `CPU · ${detail}` : `${n} · ${detail}`)));
  $('#hud-fast').classList.toggle('hidden', !settings.fastGarbage);
  $('#hud-outbreak').classList.toggle('hidden', !(settings.outbreak && count >= 2));
  enterPlay();
}

// --- Local matches: several people on this screen (controllers, the keyboard) and CPUs ---

const localSetup = new LocalSetup(settings, { onStart: startLocal, onBack: showMenu });
/** The connected controllers last shown on the local setup or online lobby screen. */
let shownPads = '';
function updatePadLists(): void {
  const lobby = !lobbyScreen.classList.contains('hidden');
  if (!localSetup.visible && !lobby) return void (shownPads = '');
  const list = pad.list();
  const key = JSON.stringify(list);
  if (key !== shownPads) {
    shownPads = key;
    if (localSetup.visible) localSetup.setPads(list);
    else room.setPads(list);
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
  overlay.key = '';
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

// --- Online rounds ---

/**
 * A round starts (the first from the lobby, later ones automatically): your board on the shared
 * seed, and your couch guests' boards (each played with their own controller).
 */
function startOnline(info: StartInfo): void {
  const me = info.players.find(p => p.id === room.me);
  const mine = info.players.filter(p => p.guestOf === room.me);
  const others = info.players.filter(p => p.id !== room.me && p.guestOf !== room.me);
  if (!me || mine.length + others.length === 0) return;
  const now = performance.now();
  const newGame = (p: StartInfo['players'][number]) =>
    new Game({ level: p.level, speed: p.speed, seed: info.seed, fastGarbage: info.settings.fastGarbage, playerSalt: p.id });
  const pads = new Map<number, KeyboardInput>();
  const guests: OnlineGuest[] = mine.map(p => {
    const index = room.guestPads.get(p.id) ?? null;
    const input = new KeyboardInput(); // fed by their controller only
    input.enabled = true;
    if (index !== null) pads.set(index, input);
    return { id: p.id, name: p.name, game: newGame(p), input, rumble: rumble.forPad(index ?? -1), pad: index, resultSent: false, lastSent: { json: '', at: 0 } };
  });
  // Every other controller (and the keyboard) drives you. With guests, only your own controller rumbles for you.
  routePads(guests.length ? pads : null, keyboard);
  const ownPad = room.ownPad;
  session = {
    kind: 'online',
    game: newGame(me),
    guests,
    rumble: guests.length ? rumble.forPad(ownPad ?? -1) : rumble,
    info,
    opps: others.map(p => ({ id: p.id, name: p.name, mine: p.runBy === room.me, snap: null, at: now, out: false })),
    startAt: now + info.startInMs,
    pausedBy: null,
    away: null,
    result: null,
    resultSent: false,
    lastSent: { json: '', at: 0 },
  };
  const label = (p: StartInfo['players'][number]) =>
    `${p.name}${p.cpu ? ` (CPU ${SKILL_LABEL[p.cpu]})` : ''} · Lv ${p.level} · ${SPEED_LABEL[p.speed]}`;
  if (guests.length) {
    // Everyone on this screen by name, your bottle labelled like the others.
    const pad = (g: OnlineGuest) => (g.pad === null ? '🎮' : `🎮 ${g.pad + 1}`);
    setupPlayers([me.name, ...mine.map(p => p.name), ...others.map(p => p.name)],
      [...mine.map((p, k) => `${p.name} · ${pad(guests[k])} · Lv ${p.level} · ${SPEED_LABEL[p.speed]}`), ...others.map(label)]);
    $('#board-label').textContent = label(me);
  } else {
    setupPlayers(['You', ...others.map(p => p.name)], others.map(label));
  }
  // The CPUs this browser plays this round.
  cpuRunner.start(info.players.filter(p => p.cpu && p.runBy === room.me).map(p => ({
    id: p.id, level: p.level, speed: p.speed, skill: p.cpu!, seed: info.seed, aiSeed: randomSeed(), fastGarbage: info.settings.fastGarbage,
  })), session.startAt);
  $('#hud-fast').classList.toggle('hidden', !info.settings.fastGarbage);
  $('#hud-outbreak').classList.toggle('hidden', !(info.settings.outbreak && info.players.length >= 3));
  overlay.key = '';
  enterPlay();
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
        if (s.result) break;
        // For one of your couch guests.
        const gi = s.guests.findIndex(g => g.id === msg.to);
        if (gi >= 0) {
          const g = s.guests[gi];
          g.game.receiveGarbage(msg.colors);
          opponents.fx(gi).markIncoming();
          audio.play('warning', 0, 0); g.rumble.warning();
          break;
        }
        // For a CPU this browser plays.
        const k = s.opps.findIndex(o => o.id === msg.to && o.mine);
        if (k >= 0) {
          cpuRunner.garbage(msg.to, msg.colors);
          opponents.fx(oppSlot(s, k)).markIncoming();
        }
        break;
      }
      // The server only sends garbage to the players it targeted.
      if (opp && !s.result) {
        s.game.receiveGarbage(msg.colors);
        youFx.markIncoming();
        audio.play('warning', 0, 0); s.rumble.warning();
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
      resetInputs();
      break;
    case 'away':
      if (msg.id !== room.me) s.away = { name: msg.name, until: now + msg.graceMs };
      break;
    case 'back':
      // An opponent came back, or you did after a blip: resume after a countdown.
      if (msg.id !== room.me) s.away = null;
      s.startAt = now + msg.resumeInMs;
      for (const o of s.opps) o.at = now;
      resetInputs();
      break;
    case 'round':
      onOnlineRound(s, msg);
      break;
  }
}

function onOnlineRound(s: OnlineSession, r: RoundResult): void {
  s.result = r;
  cpuRunner.sync(true, s.startAt);
  overlay.hide(); // leave the boards visible for a moment before the result
  overlay.key = 'result';
  audio.stopMusic();
  if (r.winner) {
    // A win for anyone on this screen gets the happy jingle.
    audio.jingle(r.winner === room.me || s.guests.some(g => g.id === r.winner) ? 'win' : 'lose');
    s.rumble.roundEnd(r.winner === room.me);
    for (const g of s.guests) g.rumble.roundEnd(r.winner === g.id);
  }
  const { title, sub } = s.guests.length
    ? onlineRoundText(r, room.me, [...s.guests, ...s.opps], s.info.round, hud.playerNames[0])
    : onlineRoundText(r, room.me, s.opps, s.info.round);
  overlay.showLater(ROUND_END_LINGER_MS, title, sub, r.matchOver ? [
    ['Play again', () => playAgainOnline(s)],
    ['Back to lobby', leaveOnlineMatch],
    ['Leave room', () => room.leave()],
  ] : []);
}

/** Ready for another match with the same settings; it starts once everyone agrees. */
function playAgainOnline(s: OnlineSession): void {
  room.send({ t: 'playAgain' });
  const waitingFor = s.opps.length === 1 ? s.opps[0].name : 'the others';
  overlay.show('Play again', `Waiting for ${waitingFor}…`, [['Back to lobby', leaveOnlineMatch]]);
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
  const guest = (id: string) => s.guests.find(g => g.id === id);
  const alive = seats.map(id =>
    id === room.me ? s.game.phase !== 'lost' : guest(id) ? guest(id)!.game.phase !== 'lost' : !s.opps.find(o => o.id === id)?.out);
  for (const t of garbageTargets(seats.indexOf(from), alive, firstColors, s.info.settings.outbreak)) {
    if (seats[t] === room.me || guest(seats[t])) continue; // warnings on this screen come with the garbage itself
    const k = s.opps.findIndex(o => o.id === seats[t]);
    if (k >= 0) opponents.fx(oppSlot(s, k)).markIncoming();
  }
}

/** Your board ended on its own (cleared or topped out): tell the room. The server decides the round. */
function onOnlineOver(game: Game): void {
  if (session?.kind !== 'online' || session.resultSent) return;
  session.resultSent = true;
  room.send({ t: 'result', outcome: game.phase === 'won' ? 'cleared' : 'toppedOut' });
}

/**
 * Send your board (and your couch guests') if it changed (at most BOARD_SNAPSHOT_HZ), or anyway
 * every so often as a heartbeat.
 */
function sendBoard(s: OnlineSession, now: number): void {
  sendOneBoard(s, now);
  for (const g of s.guests) sendOneBoard(g, now, g.id);
}

function sendOneBoard(b: { game: Game; lastSent: { json: string; at: number } }, now: number, as?: string): void {
  if (now - b.lastSent.at < 1000 / BOARD_SNAPSHOT_HZ) return;
  const json = JSON.stringify(encodeSnapshot(b.game));
  if (json !== b.lastSent.json || now - b.lastSent.at >= SNAPSHOT_KEEPALIVE_MS) {
    room.send({ t: 'board', snap: JSON.parse(json), ...(as && { as }) });
    b.lastSent = { json, at: now };
  }
}

// Browsers stop requestAnimationFrame in hidden tabs, but timers keep running (about once a
// second). This keeps the heartbeat going so a backgrounded tab doesn't look disconnected.
setInterval(() => {
  if (session?.kind !== 'online') return;
  const now = performance.now();
  sendBoard(session, now);
  cpuRunner.sync(cpuHold(session, now, room.connected), session.startAt);
}, SNAPSHOT_KEEPALIVE_MS);

/** Once per frame during an online round: send your board, and show the right overlay. */
function updateOnline(s: OnlineSession, now: number): void {
  sendBoard(s, now);
  cpuRunner.sync(cpuHold(s, now, room.connected), s.startAt);

  const hold = onlineHold(s, now, room.connected);
  if (hold === 'result') return; // result overlay is already up
  const secs = (t: number) => String(Math.max(0, Math.ceil((t - now) / 1000)));
  switch (hold) {
    case 'over':
      if (s.game.phase === 'lost' && s.opps.filter(o => !o.out).length > 1) {
        return overlay.setState('over', "You're out", 'Watching the others finish the round…', []);
      }
      return overlay.setState('over', s.game.phase === 'won' ? 'Bottle clean!' : 'Topped out', 'Waiting for the result…', []);
    case 'reconnecting':
      return overlay.setState('reconnecting', 'Reconnecting…', 'Your connection dropped. Hang on…', []);
    case 'away':
      return overlay.setState('away', `${s.away!.name} disconnected`, `${s.away!.name} has ${secs(s.away!.until)} s to come back`, []);
    case 'paused':
      return overlay.setState('paused', 'Paused', `Paused by ${s.pausedBy}. Anyone can resume.`, [
        ['Resume', () => room.send({ t: 'pause', paused: false })],
        ['Leave room', () => room.leave()],
      ]);
    case 'stale':
      return overlay.setState('stale', 'Connection problem…', `Waiting to hear from ${staleOpponent(s, now)?.name ?? 'the others'}`, []);
    case 'countdown': {
      const vs = s.opps.length === 1 ? `vs ${s.opps[0].name}` : `vs ${s.opps.map(o => o.name).join(', ')}`;
      return overlay.setState('countdown', secs(s.startAt), (s.info.round > 1 ? `Round ${s.info.round}` : vs) + touchUi.tip, []);
    }
    default:
      overlay.clearState();
  }
}

// --- Vs CPU and local rounds ---

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
  overlay.key = '';
  overlay.hide();
}

/** Show 3-2-1 before each round, then get out of the way. */
function updateCpuCountdown(s: CpuSession, now: number): void {
  if (s.match.state !== 'playing' || paused) return;
  if (now < s.startAt) {
    const n = s.seats.length - 1;
    const vs = s.local ? hud.playerNames.join(' vs ') : n === 1 ? 'vs CPU' : `vs ${n} CPUs`;
    overlay.setState('countdown', String(Math.ceil((s.startAt - now) / 1000)), (s.match.round > 1 ? `Round ${s.match.round}` : vs) + (s.local ? '' : touchUi.tip), []);
  } else {
    overlay.clearState('countdown');
  }
}

// --- Board sizes ---

function layoutOptions(): LayoutOptions {
  return { pad: touchUi.buttonsShown(touchGame()), local: (session?.kind === 'cpu' && session.local) || hasGuests(session) };
}

function sizeCanvases(): void {
  touchUi.update(touchGame()); // show or hide the touch buttons first, so they can be measured
  layout.size(layoutOptions());
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

/** Music tempo follows the game (see musicRate). Called every frame; only changes when needed. */
let lastMusicRate = 1;
function updateMusicRate(): void {
  const me = you();
  if (!me || !session) return;
  const others =
    session.kind === 'cpu' ? session.match.games.slice(1).filter(g => g.phase !== 'lost').map(g => g.germsLeft) :
    session.kind === 'online' ? [
      ...session.guests.filter(g => g.game.phase !== 'lost').map(g => g.game.germsLeft),
      ...session.opps.filter(o => !o.out && o.snap).map(o => o.snap!.g),
    ] : [];
  const rate = musicRate(me.speedStep, [me.germsLeft, ...others]);
  if (Math.abs(rate - lastMusicRate) > 0.001) {
    lastMusicRate = rate;
    audio.setMusicRate(rate);
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
    overlay.showLater(ROUND_END_LINGER_MS, 'Bottle clean!', `Level ${lvl} cleared`, buttons);
  } else {
    audio.jingle('lose');
    overlay.showLater(ROUND_END_LINGER_MS, 'Topped out', `${game.germsLeft} germs left`, [['Retry', () => startSolo(lvl)], ['Menu', showMenu]]);
  }
}

function onRoundOver(match: Match): void {
  audio.stopMusic();
  if (session?.kind === 'cpu' && session.local) return onLocalRoundOver(match, session.seats);
  const w = match.roundWinner;
  if (w !== null) {
    audio.jingle(w === 0 ? 'win' : 'lose');
    rumble.roundEnd(w === 0);
  }
  const { title, sub } = cpuRoundText(match, hud.playerNames);
  overlay.showLater(ROUND_END_LINGER_MS, title, sub, match.state === 'matchOver'
    ? [['Play again', startCpuMatch], ['Menu', showMenu]]
    : [['Next round', nextRound], ['Menu', showMenu]]);
}

/** A local match round ended: everyone on this screen is named (P1, P2, Spike…). */
function onLocalRoundOver(match: Match, seats: Seat[]): void {
  const w = match.roundWinner;
  if (w !== null) audio.jingle(seats[w].kind === 'person' ? 'win' : 'lose');
  seats.forEach((s, i) => { if (s.kind === 'person') s.rumble.roundEnd(i === w); });
  const { title, sub } = localRoundText(match, hud.playerNames);
  overlay.showLater(ROUND_END_LINGER_MS, title, sub, match.state === 'matchOver' ? [
    ['Play again', () => startLocal(lastLocal)],
    ['Change players', () => { session = null; audio.stopMusic(); localSetup.show(); }],
    ['Menu', showMenu],
  ] : [['Next round', nextRound], ['Menu', showMenu]]);
}

// --- Pause ---

/** Why an online pause was refused, for the message. */
const PAUSE_REFUSED = {
  result: 'the round is over', over: 'your board is done', reconnecting: 'reconnecting',
  away: 'waiting for a player', stale: 'connection problem',
} as const;

function togglePause(): void {
  if (session?.kind === 'online') {
    // Shared pause: the server tells both players; resuming has a countdown.
    const s = session;
    const hold = onlineHold(s, performance.now(), room.connected);
    if (hold !== null && hold !== 'countdown' && hold !== 'paused') {
      console.info(`[pause] not now: ${hold}`);
      showToast(`Can't pause right now (${PAUSE_REFUSED[hold]})`);
      return;
    }
    const wanted = !s.pausedBy;
    room.send({ t: 'pause', paused: wanted });
    // The pause only happens when the server passes it back to everyone; say so if it doesn't.
    setTimeout(() => {
      if (session !== s || !!s.pausedBy === wanted) return;
      console.warn(`[pause] no answer from the room (connected: ${room.connected})`);
      showToast(wanted ? "Pause didn't go through" : "Resume didn't go through");
    }, 2000);
    return;
  }
  if (!running() && !paused) return;
  paused = !paused;
  audio.setMusicPaused(paused);
  resetInputs();
  if (paused) overlay.show('Paused', settings.touch !== 'off' ? 'Tap Resume to keep playing' : 'Press P to resume', [['Resume', togglePause], ['Quit to menu', showMenu]]);
  else overlay.hide();
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

const padMenus = new PadMenus(topBar, {
  // A menu is up: no session (title / lobby), paused, or an overlay with buttons (between rounds).
  active: () => !session || paused || (session.kind === 'online' && !!session.pausedBy) || overlay.hasButtons,
  joinPad: index => localSetup.joinPad(index) || room.joinPad(index),
});

// --- Loop: fixed-step simulation on the real clock, render every frame ---

const mascots = new Mascots();

function step(): void {
  if (!session) return;
  if (session.kind === 'solo' || session.kind === 'online') {
    const g = session.game;
    g.step(SIM_STEP_MS, keyboard.poll(SIM_STEP_MS));
    const events = g.drainEvents();
    handleYourEvents(events, keyboard, session.kind === 'online' ? session.rumble : rumble);
    youFx.onEvents(events);
    if (session.kind === 'online') {
      sendGarbage(session, events);
      stepGuests(session);
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

/** Garbage from a board on this screen (yours, or a couch guest's `as` them) goes to the room, which picks the targets. */
function sendGarbage(s: OnlineSession, events: GameEvent[], as?: string): void {
  for (const e of events) {
    if (e.type !== 'garbageOut') continue;
    room.send({ t: 'garbage', colors: e.colors, firstColors: e.firstColors, ...(as && { as }) });
    blinkTargets(s, as ?? room.me, e.firstColors);
  }
}

/** Your couch guests' boards: one step each, with their own controller, sounds and rumble. */
function stepGuests(s: OnlineSession): void {
  s.guests.forEach((g, k) => {
    g.game.step(SIM_STEP_MS, g.input.poll(SIM_STEP_MS));
    const events = g.game.drainEvents();
    handleYourEvents(events, g.input, g.rumble);
    opponents.fx(k).onEvents(events);
    sendGarbage(s, events, g.id);
    if (g.game.isOver && !g.resultSent) {
      g.resultSent = true;
      room.send({ t: 'result', outcome: g.game.phase === 'won' ? 'cleared' : 'toppedOut', as: g.id });
    }
  });
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
      ...session.guests.map(g => ({ wins: wins[g.id] ?? 0, germs: g.game.germsLeft, out: g.game.phase === 'lost' })),
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
  if (session && layout.stale(layoutOptions())) sizeCanvases();

  if (session?.kind === 'online') updateOnline(session, now);
  if (session?.kind === 'cpu') updateCpuCountdown(session, now);
  updateChat();
  voiceBar.tick();
  updatePadLists();
  touchUi.update(touchGame());

  if (running()) {
    acc += dt;
    while (acc >= SIM_STEP_MS && running()) {
      step();
      acc -= SIM_STEP_MS;
    }
  }

  const me = you();
  if (!session) mascots.draw(now);
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
      session.kind === 'online' && session.guests.length + session.opps.length > 1 && session.game.phase === 'lost';
    $('#play').classList.toggle('you-out', youOut);
    if (session.kind === 'online') {
      const s = session;
      s.guests.forEach((g, k) => opponents.draw(k, hidden ? null : gameView(g.game, opponents.fx(k)), now, g.game.phase === 'lost'));
      s.opps.forEach((o, k) => {
        const slot = oppSlot(s, k);
        opponents.draw(slot, o.snap && !hidden ? snapshotView(o.snap, opponents.fx(slot).incomingFresh) : null, now, o.out);
      });
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
