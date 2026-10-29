// Browser smoke test: starts the game in a real browser (the Edge or Chrome installed on this
// computer) and checks the things unit tests can't see: the menu fits, each mode starts and
// pauses, and the touch buttons keep clear of your bottle on a phone-sized screen.
// Online play needs the relay too, so it isn't covered here.
//
//   npm run test:browser

import { chromium } from 'playwright-core';
import { createServer } from 'vite';

const server = await createServer({ server: { port: 5198, strictPort: true }, logLevel: 'error' });
await server.listen();
const BASE = 'http://localhost:5198';

const browser = await launch();
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

/** A fresh page with these saved settings, and every page error counted as a failure. */
async function open({ width = 1300, height = 800, touch = false, settings = {} } = {}) {
  const context = await browser.newContext({ viewport: { width, height }, hasTouch: touch });
  await context.addInitScript(s => localStorage.setItem('drzerg.settings', s), JSON.stringify(settings));
  const page = await context.newPage();
  page.on('pageerror', e => check(`no page errors (${e.message})`, false));
  await page.goto(BASE);
  await page.waitForSelector('#menu:not(.hidden)');
  return page;
}

const overlayTitle = page => page.evaluate(() =>
  document.querySelector('#overlay').classList.contains('hidden') ? null : document.querySelector('#overlay-title').textContent);

/** Wait out the 3-2-1 countdown (pause does nothing until the round is running). */
const roundRunning = page => page.waitForFunction(() => {
  const s = window.__session?.();
  return s && !(performance.now() < (s.startAt ?? 0)) && document.querySelector('#overlay').classList.contains('hidden');
}, null, { timeout: 6000 });

/** P pauses and Escape resumes once the round is running. */
async function checkPause(page, mode) {
  await roundRunning(page);
  await page.keyboard.press('KeyP');
  check(`${mode}: P pauses`, (await overlayTitle(page)) === 'Paused');
  await page.keyboard.press('Escape');
  check(`${mode}: Escape resumes`, (await overlayTitle(page)) === null);
}

try {
  console.log('Menu');
  for (const [width, height] of [[1300, 800], [360, 740]]) {
    const page = await open({ width, height, settings: { mode: 'online' } });
    const { panel, buttons, clipped } = await page.evaluate(() => {
      const box = el => el.getBoundingClientRect();
      const all = [...document.querySelectorAll('#mode button')];
      return {
        panel: box(document.querySelector('#menu .panel')).right,
        buttons: Math.max(...all.map(b => box(b).right)),
        clipped: all.filter(b => b.scrollWidth > b.clientWidth).map(b => b.textContent),
      };
    });
    check(`${width}px: mode buttons inside the panel`, buttons <= panel, `${Math.round(buttons)} > ${Math.round(panel)}`);
    check(`${width}px: no mode label cut off`, clipped.length === 0, clipped.join(', '));
    await page.context().close();
  }

  console.log('Solo');
  {
    const page = await open({ settings: { mode: 'solo' } });
    await page.click('#start');
    check('the board shows', await page.isVisible('#board'));
    await checkPause(page, 'solo');
    await page.context().close();
  }

  console.log('Vs CPU');
  {
    const page = await open({ settings: { mode: 'cpu', cpuCount: 2 } });
    await page.click('#start');
    check('a 3-2-1 countdown first', /^[123]$/.test((await overlayTitle(page)) ?? ''));
    check('two CPU bottles', (await page.locator('#opponents canvas').count()) === 2);
    await checkPause(page, 'vs CPU');
    await page.context().close();
  }

  console.log('Local');
  {
    const page = await open({ settings: { mode: 'local' } });
    await page.click('#start');
    await page.click('#local-keyboard');
    await page.click('#local-add-cpu');
    await page.click('#local-start');
    check('the match starts', await page.isVisible('#play'));
    await checkPause(page, 'local');
    await page.context().close();
  }

  console.log('Controllers');
  {
    const page = await open({ settings: { mode: 'local' } });
    // Two pretend controllers; press() holds a button for a few frames.
    await page.evaluate(() => {
      const pad = i => ({ id: `Test pad ${i}`, index: i, connected: true, mapping: 'standard', timestamp: 0, axes: [0, 0, 0, 0],
        buttons: Array.from({ length: 17 }, () => ({ pressed: false, touched: false, value: 0 })) });
      window.__pads = [pad(0), pad(1)];
      navigator.getGamepads = () => window.__pads;
    });
    const press = async (i, button) => {
      await page.evaluate(([i, b]) => { window.__pads[i].buttons[b].pressed = true; }, [i, button]);
      await page.waitForTimeout(100);
      await page.evaluate(([i, b]) => { window.__pads[i].buttons[b].pressed = false; }, [i, button]);
      await page.waitForTimeout(100);
    };
    const [CROSS, DOWN] = [0, 13];
    await press(0, DOWN);
    check('the D-pad selects a menu button', await page.evaluate(() => document.activeElement?.id === 'start'));
    await press(0, CROSS);
    check('✕ presses it (local setup opens)', await page.isVisible('#local-start'));
    await press(0, CROSS);
    await press(1, CROSS);
    const joined = await page.evaluate(() => document.querySelector('#local').textContent.match(/joined as/g)?.length ?? 0);
    check('✕ on each controller joins', joined === 2, `${joined} joined`);
    await page.context().close();
  }

  console.log('Touch buttons on a phone');
  for (const [width, height] of [[412, 810], [375, 667]]) {
    const page = await open({ width, height, touch: true, settings: { mode: 'cpu', cpuCount: 3, touch: 'buttons' } });
    await page.click('#start');
    await page.waitForTimeout(500);
    const { bottle, buttons, overflow } = await page.evaluate(() => ({
      bottle: document.querySelector('#board').getBoundingClientRect().bottom,
      buttons: Math.min(...[...document.querySelectorAll('#touch-pad .cluster')].map(c => c.getBoundingClientRect().top)),
      overflow: document.documentElement.scrollWidth > document.documentElement.clientWidth,
    }));
    check(`${width}×${height}: buttons show`, await page.isVisible('#touch-pad'));
    check(`${width}×${height}: bottle clear of the buttons`, bottle <= buttons, `${Math.round(bottle)} > ${Math.round(buttons)}`);
    check(`${width}×${height}: no sideways scrolling`, !overflow);
    await roundRunning(page);
    await page.click('#touch-pause');
    check(`${width}×${height}: ⏸ pauses`, (await overlayTitle(page)) === 'Paused');
    await page.context().close();
  }
} finally {
  await browser.close();
  await server.close();
}

console.log(failures.length ? `\n${failures.length} of ${checks} checks failed` : `\nAll ${checks} checks passed`);
process.exit(failures.length ? 1 : 0);

/** The installed Edge, or else Chrome. */
async function launch() {
  for (const channel of ['msedge', 'chrome']) {
    try {
      return await chromium.launch({ channel });
    } catch {}
  }
  throw new Error('Needs Microsoft Edge or Google Chrome installed.');
}
