// Take the GreenCLI screenshots in docs/screenshots, with demo data.
//
//   npm run build && npm run screenshots
//
// It serves the built app from dist/ (or opens --url), fakes the GreenCLI
// backend with made-up hosts, output and AI answers (scripts/screenshots/),
// and saves one PNG per screen. Nothing talks to a real device or AI.
//
// Options (flag or env var):
//   --out <dir>    SHOT_OUT       where the PNGs go (default docs/screenshots)
//   --url <url>    SHOT_URL       use a running copy of the app instead of dist/
//   --only <list>  SHOT_ONLY      just these shots, e.g. --only 01,05
//                  SHOT_CHROMIUM  a Chromium to use instead of Playwright's own
//
// Needs Playwright's Chromium once: npx playwright install chromium
// (in CI: npx playwright install --with-deps chromium).

import { createServer } from 'node:http';
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, extname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from '@playwright/test';
import { installDemoBackend } from './screenshots/demo-backend.mjs';
import { demo, seedStorage } from './screenshots/demo-data.mjs';
import { shots } from './screenshots/shots.mjs';
import { shrinkPng } from './screenshots/png.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

function option(flag, env, fallback) {
  const i = process.argv.indexOf(flag);
  if (i !== -1 && process.argv[i + 1]) return process.argv[i + 1];
  return process.env[env] || fallback;
}

const outDir = resolve(option('--out', 'SHOT_OUT', join(root, 'docs', 'screenshots')));
const only = option('--only', 'SHOT_ONLY', '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);
let url = option('--url', 'SHOT_URL', '');

// ── Serve dist/ unless a URL was given ──
let server = null;
if (!url) {
  const dist = join(root, 'dist');
  if (!existsSync(join(dist, 'index.html'))) {
    console.error('No dist/ found. Run "npm run build" first, or pass --url.');
    process.exit(1);
  }
  const MIME = {
    '.html': 'text/html',
    '.js': 'text/javascript',
    '.css': 'text/css',
    '.svg': 'image/svg+xml',
    '.png': 'image/png',
    '.ttf': 'font/ttf',
    '.woff2': 'font/woff2',
    '.json': 'application/json',
  };
  server = createServer((req, res) => {
    let path;
    try {
      path = decodeURIComponent((req.url || '/').split('?')[0]);
    } catch {
      res.statusCode = 400;
      res.end('Bad URL');
      return;
    }
    let file = join(dist, path === '/' ? 'index.html' : path);
    if (!file.startsWith(dist + sep) || !existsSync(file) || statSync(file).isDirectory()) {
      file = join(dist, 'index.html');
    }
    res.setHeader('content-type', MIME[extname(file)] || 'application/octet-stream');
    res.end(readFileSync(file));
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  url = `http://127.0.0.1:${server.address().port}/`;
}

mkdirSync(outDir, { recursive: true });

let browser;
try {
  browser = await chromium.launch(process.env.SHOT_CHROMIUM ? { executablePath: process.env.SHOT_CHROMIUM } : {});
} catch (e) {
  console.error(String(e).split('\n')[0]);
  console.error('Could not start Chromium. Run "npx playwright install chromium", or set SHOT_CHROMIUM.');
  server?.close();
  process.exit(1);
}

// Every shot's clock starts at the same moment (it still runs), so the times
// the app shows are the same on every run.
const DEMO_TIME = Date.UTC(2026, 9, 2, 9, 41, 0);
function startClockAt(start) {
  const RealDate = Date;
  const offset = start - RealDate.now();
  class DemoDate extends RealDate {
    constructor(...args) {
      if (args.length) super(...args);
      else super(RealDate.now() + offset);
    }
    static now() {
      return RealDate.now() + offset;
    }
  }
  window.Date = DemoDate;
}

const started = Date.now();
let failed = 0;
for (const shot of shots) {
  if (only.length && !only.some((o) => shot.file.startsWith(o))) continue;
  const context = await browser.newContext({
    viewport: { width: 1440, height: 900 },
    deviceScaleFactor: 2,
    colorScheme: 'dark',
    locale: 'en-US',
    timezoneId: 'UTC',
  });
  await context.addInitScript(startClockAt, DEMO_TIME);
  await context.addInitScript(installDemoBackend, { ...demo, ...(shot.demo || {}) });
  await context.addInitScript(seedStorage, shot.storage || {});
  const page = await context.newPage();
  const problems = [];
  page.on('pageerror', (e) => problems.push(`page error: ${e.message}`));
  page.on('console', (m) => {
    if (m.text().startsWith('[demo]')) problems.push(m.text());
  });
  try {
    await page.goto(url, { waitUntil: 'load' });
    await page.locator('nav[aria-label="Activity bar"]').waitFor({ timeout: 20000 });
    await page.evaluate(() => document.fonts.ready);
    await page.waitForTimeout(500);
    await shot.run(page);
    // Park the mouse where it shows no hover, unless the shot hovers on purpose.
    if (!shot.keepMouse) await page.mouse.move(1439, 899);
    await page.waitForTimeout(400);
    // A shot may crop to part of the window (clip, in CSS pixels).
    const clip = shot.clip ? await shot.clip(page) : undefined;
    const png = shrinkPng(await page.screenshot(clip ? { clip } : {}));
    writeFileSync(join(outDir, shot.file), png);
    console.log(`saved ${shot.file} (${Math.round(png.length / 1024)} KB)`);
  } catch (e) {
    failed++;
    console.error(`FAILED ${shot.file}: ${String(e).split('\n')[0]}`);
  }
  for (const p of problems) console.log(`  (${shot.file}) ${p}`);
  await context.close();
}

await browser.close();
server?.close();

// After a full run, the folder's README lists the pictures.
if (!only.length && !failed) {
  const lines = [
    '# Screenshots',
    '',
    'GreenCLI 2.0 with made-up demo data: no real devices, addresses, people or keys.',
    'Each picture is the 1440 x 900 window at 2x (2880 x 1800 pixels). 08 is cropped to the Settings box.',
    '',
    ...shots.map((s) => `- \`${s.file}\`: ${s.about}`),
    '',
    '## Take them again',
    '',
    '```bash',
    'npx playwright install chromium   # once',
    'npm run build',
    'npm run screenshots',
    '```',
    '',
    'This writes all the pictures and this file. `npm run screenshots -- --only 03` takes just one,',
    'and `--out <folder>` saves them somewhere else. The demo hosts, output and AI answers are in',
    '`scripts/screenshots/`. Nothing talks to a real device or AI.',
    '',
  ];
  writeFileSync(join(outDir, 'README.md'), lines.join('\n'));
}
console.log(`Done in ${Math.round((Date.now() - started) / 1000)} s. Pictures are in ${outDir}`);
if (failed) process.exit(1);
