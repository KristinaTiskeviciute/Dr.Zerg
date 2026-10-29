// Online smoke test: runs the relay (wrangler dev) and the game, puts two players in a room
// with a CPU, and checks the lobby, chat, starting a match, boards arriving, the shared pause,
// going back to the lobby between rounds and a player dropping out. Uses its own ports, so a
// dev server already running is fine.
//
//   npm run test:online

import { spawn, execSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { chromium } from 'playwright-core';
import { build, createServer } from 'vite';

const RELAY_PORT = 8797;
const GAME_PORT = 5197;
const RELAY = `http://localhost:${RELAY_PORT}`;

// The relay serves dist/, so it has to exist (any build will do; the game itself comes from Vite).
if (!existsSync('dist/index.html')) await build({ logLevel: 'error' });
const relay = spawn(`npx wrangler dev --port ${RELAY_PORT}`, { shell: true, stdio: 'ignore', env: { ...process.env, CI: '1' } });
const server = await createServer({
  server: {
    port: GAME_PORT, strictPort: true,
    proxy: { '/parties': { target: RELAY, ws: true }, '/api': { target: RELAY } },
  },
  logLevel: 'error',
});
await server.listen();
const BASE = `http://localhost:${GAME_PORT}`;
let browser;

const failures = [];
let checks = 0;
function check(name, ok, detail = '') {
  checks++;
  if (ok) console.log(`  ok  ${name}`);
  else {
    console.log(`  FAIL  ${name}${detail ? ` (${detail})` : ''}`);
    failures.push(name);
  }
}

try {
  await waitForRelay();
  browser = await launch();

  /** A player's page, with their name saved, a pretend controller, and page errors counted as failures. */
  const player = async name => {
    const context = await browser.newContext({ viewport: { width: 1200, height: 800 } });
    await context.addInitScript(n => {
      localStorage.setItem('drzerg.settings', JSON.stringify({ mode: 'online', name: n }));
      window.__pads = [{ id: 'Test pad', index: 0, connected: true, mapping: 'standard', timestamp: 0, axes: [0, 0, 0, 0],
        buttons: Array.from({ length: 17 }, () => ({ pressed: false, touched: false, value: 0 })) }];
      navigator.getGamepads = () => window.__pads;
    }, name);
    const page = await context.newPage();
    page.on('pageerror', e => check(`${name}: no page errors (${e.message})`, false));
    return page;
  };
  /** The session as the page sees it (dev builds only). */
  const session = page => page.evaluate(() => {
    const s = window.__session?.();
    return s?.kind === 'online' ? {
      pausedBy: s.pausedBy,
      running: performance.now() >= s.startAt,
      boards: Object.fromEntries(s.opps.map(o => [o.name, o.snap !== null])),
      col: s.game.active?.col ?? null,
      guests: s.guests.map(g => ({ name: g.name, col: g.game.active?.col ?? null })),
    } : null;
  });
  const until = (page, fn, arg) => page.waitForFunction(fn, arg, { timeout: 8000 }).then(() => true, () => false);
  /** Press a button on the pretend controller for a few frames. */
  const press = async (page, button) => {
    await page.evaluate(b => { window.__pads[0].buttons[b].pressed = true; }, button);
    await page.waitForTimeout(100);
    await page.evaluate(b => { window.__pads[0].buttons[b].pressed = false; }, button);
    await page.waitForTimeout(100);
  };
  const CROSS = 0;
  const rows = page => page.evaluate(() => [...document.querySelectorAll('#lobby-players li:not(.empty)')].map(li => li.textContent));

  console.log('Lobby');
  const amy = await player('Amy');
  await amy.goto(BASE);
  await amy.click('#create-room');
  check('a room is created', await until(amy, () => /^[A-Z]{4}$/.test(document.querySelector('#room-code').textContent)));
  const code = await amy.textContent('#room-code');
  const bo = await player('Bo');
  await bo.goto(`${BASE}/r/${code}`);
  check('the room link joins the room', await until(amy, () => document.querySelectorAll('#lobby-players li:not(.empty)').length === 2));
  await amy.click('#add-cpu');
  check('the host adds a CPU', await until(bo, () => document.querySelectorAll('#lobby-players li:not(.empty)').length === 3));

  // Chat (the dock may be folded away, so send through the form directly).
  await amy.evaluate(() => {
    const input = document.querySelector('.chat-form input');
    input.value = 'hello from Amy';
    input.form.requestSubmit();
  });
  check('chat reaches the other player', await until(bo, () => document.querySelector('.chat-log').textContent.includes('hello from Amy')));

  console.log('Couch players');
  // Bo came in with the mouse, so his controller isn't his yet: ✕ on it adds a couch player.
  await press(bo, CROSS);
  check('✕ on a spare controller adds a couch player', await until(amy, () =>
    [...document.querySelectorAll('#lobby-players li')].some(li => li.textContent.includes('Bo 2') && li.textContent.includes('COUCH'))));
  await bo.evaluate(() => {
    const input = document.querySelector('input.guest-name');
    input.value = 'Kat';
    input.dispatchEvent(new Event('change', { bubbles: true }));
  });
  await bo.click('.guest-row [data-action="up"]');
  check("their own browser renames them and changes their level", await until(amy, () =>
    [...document.querySelectorAll('#lobby-players li')].some(li => li.textContent.includes('Kat') && li.textContent.includes('Lv 6'))));
  check('the room shows whose screen they are on', (await rows(amy)).some(r => r.includes("on Bo's screen")));
  await press(bo, CROSS);
  check('the same controller doesn\'t add a second one', (await rows(bo)).length === 4);
  await bo.click('.guest-row [data-action="remove"]');
  check('and removes them', await until(amy, () => document.querySelectorAll('#lobby-players li:not(.empty)').length === 3));
  // Phones held upright: no couch players (the screen is too narrow), just a hint to turn it.
  await bo.setViewportSize({ width: 390, height: 844 });
  await press(bo, CROSS);
  check('a phone held upright asks to turn sideways instead', await until(bo, () => document.querySelector('#toast').textContent.includes('sideways'))
    && (await rows(bo)).length === 3);
  await bo.setViewportSize({ width: 1200, height: 800 });
  await press(bo, CROSS); // a couch player for the match (a new one, Bo 2)
  check('a couch player joins again for the match', await until(amy, () => document.querySelectorAll('#lobby-players li:not(.empty)').length === 4));

  console.log('Match');
  await amy.click('#ready-btn');
  await bo.click('#ready-btn');
  await amy.click('#start-online');
  check('the match starts for both', await until(amy, () => window.__session?.()?.kind === 'online') && await until(bo, () => window.__session?.()?.kind === 'online'));
  await until(amy, () => { const s = window.__session?.(); return s && performance.now() >= s.startAt + 1000; });
  const a = await session(amy);
  const b = await session(bo);
  check("Amy sees Bo's and the CPU's boards", a && Object.values(a.boards).every(Boolean), JSON.stringify(a?.boards));
  check("Bo sees Amy's and the CPU's boards", b && Object.values(b.boards).every(Boolean), JSON.stringify(b?.boards));
  check("Amy sees the couch player's board", a && Object.keys(a.boards).length === 3, JSON.stringify(a?.boards));
  check("the couch player's board runs on Bo's screen", b?.guests.length === 1, JSON.stringify(b?.guests));
  // Their controller moves their capsule, not Bo's (Bo plays on the keyboard).
  const RIGHT = 15;
  const before = await session(bo);
  await press(bo, RIGHT);
  const after = await session(bo);
  check("the couch player's controller moves only their capsule",
    after.guests[0].col === before.guests[0].col + 1 && after.col === before.col, `${JSON.stringify(before)} → ${JSON.stringify(after)}`);

  // The couch player tops out (forced, to keep the test quick): the room knocks them out, for everyone.
  await bo.evaluate(() => { window.__session().guests[0].game.phase = 'lost'; });
  check("a couch player topping out knocks them out for everyone", await until(amy, () =>
    window.__session?.()?.opps.find(o => o.name === 'Bo 2')?.out === true));

  console.log('Pause');
  await amy.keyboard.press('KeyP');
  check('P pauses for everyone', await until(bo, () => window.__session?.()?.pausedBy === 'Amy' && document.querySelector('#overlay-title').textContent === 'Paused'));
  await bo.keyboard.press('KeyP');
  check('anyone can resume', await until(amy, () => window.__session?.()?.pausedBy === null));

  console.log('Back to lobby between rounds');
  // Amy and Bo top out too (told to the room directly): the CPU takes round 1, and the match goes on.
  await until(amy, () => window.__session?.()?.startAt <= performance.now());
  for (const page of [amy, bo]) await page.evaluate(() => window.__send({ t: 'result', outcome: 'toppedOut' }));
  const lobbyButton = '#overlay-buttons button';
  check('the round result offers a way back to the lobby', await until(amy, sel =>
    [...document.querySelectorAll(sel)].some(b => b.textContent === 'Back to lobby' && b.offsetParent), lobbyButton));
  check("it isn't selected (a stray ✕ can't end the match)", await amy.evaluate(sel => !document.activeElement?.matches(sel), lobbyButton));
  await amy.click(lobbyButton);
  check('it takes everyone back to the lobby', await until(amy, () => !document.querySelector('#lobby').classList.contains('hidden'))
    && await until(bo, () => !document.querySelector('#lobby').classList.contains('hidden') && window.__session?.() == null));
  check('and the others are told who', await until(bo, () => document.querySelector('#toast').textContent.includes('Amy went back to the lobby')));

  console.log('Dropping out');
  await amy.click('#ready-btn');
  await bo.click('#ready-btn');
  await amy.click('#start-online');
  await until(bo, () => { const s = window.__session?.(); return s && performance.now() >= s.startAt; });
  await bo.context().close();
  check('the others are told and wait for them', await until(amy, () => document.querySelector('#overlay-title').textContent.includes('Bo disconnected')));
} finally {
  await browser?.close();
  await server.close();
  stop(relay);
}

console.log(failures.length ? `\n${failures.length} of ${checks} checks failed` : `\nAll ${checks} checks passed`);
process.exit(failures.length ? 1 : 0);

/** Wait until the relay answers (the first start can take a while). */
async function waitForRelay() {
  for (let i = 0; i < 120; i++) {
    try {
      if ((await fetch(`${RELAY}/api/ice`)).ok) return;
    } catch {}
    await new Promise(r => setTimeout(r, 500));
  }
  throw new Error(`The relay didn't start on port ${RELAY_PORT}.`);
}

/** Stop the relay and the processes it started. */
function stop(proc) {
  if (process.platform === 'win32') {
    try { execSync(`taskkill /pid ${proc.pid} /t /f`, { stdio: 'ignore' }); } catch {}
  } else proc.kill();
}

/** The installed Edge, or else Chrome. */
async function launch() {
  for (const channel of ['msedge', 'chrome']) {
    try {
      return await chromium.launch({ channel });
    } catch {}
  }
  throw new Error('Needs Microsoft Edge or Google Chrome installed.');
}
