// Online smoke test: runs the relay (wrangler dev) and the game, puts two players in a room
// with a CPU, and checks the lobby, chat, starting a match, boards arriving, the shared pause
// and a player dropping out. Uses its own ports, so a dev server already running is fine.
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

  /** A player's page, with their name saved and page errors counted as failures. */
  const player = async name => {
    const context = await browser.newContext({ viewport: { width: 1200, height: 800 } });
    await context.addInitScript(n => localStorage.setItem('drzerg.settings', JSON.stringify({ mode: 'online', name: n })), name);
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
    } : null;
  });
  const until = (page, fn, arg) => page.waitForFunction(fn, arg, { timeout: 8000 }).then(() => true, () => false);

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

  console.log('Pause');
  await amy.keyboard.press('KeyP');
  check('P pauses for everyone', await until(bo, () => window.__session?.()?.pausedBy === 'Amy' && document.querySelector('#overlay-title').textContent === 'Paused'));
  await bo.keyboard.press('KeyP');
  check('anyone can resume', await until(amy, () => window.__session?.()?.pausedBy === null));

  console.log('Dropping out');
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
