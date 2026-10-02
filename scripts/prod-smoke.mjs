// Production-bundle smoke test: serves dist/ and verifies the app actually
// mounts. Catches startup crashes the dev-server e2e can't see — chunk
// evaluation-order bugs in the minified build render as a white screen in the
// packaged app (this exact failure shipped in v1.2.1).
//
// Two runs:
//  A. With a stub of the Tauri 2 IPC globals (__TAURI_INTERNALS__), whose
//     invoke always rejects. Backend calls fail as they would if the backend
//     were broken; the app must still mount. Only those rejections (marked
//     "__TAURI_INTERNALS__ unavailable") are allowed as page errors.
//  B. With no Tauri globals at all (a plain browser). The app must mount with
//     ZERO page errors, unhandled rejections included: code outside the
//     `isTauri` checks must never reach for Tauri internals.
//
// Usage: npm run build && node scripts/prod-smoke.mjs
import { chromium } from '@playwright/test';
import { createServer } from 'http';
import { readFileSync, existsSync } from 'fs';
import { join, extname, dirname } from 'path';
import { fileURLToPath } from 'url';

const DIST = join(dirname(fileURLToPath(import.meta.url)), '..', 'dist');
const MIME = {
  '.html': 'text/html',
  '.js': 'text/javascript',
  '.css': 'text/css',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.woff2': 'font/woff2',
};
const MARKER = '__TAURI_INTERNALS__ unavailable';

const server = createServer((req, res) => {
  let p = join(DIST, req.url.split('?')[0] === '/' ? 'index.html' : req.url.split('?')[0]);
  if (!existsSync(p)) p = join(DIST, 'index.html');
  res.setHeader('content-type', MIME[extname(p)] || 'application/octet-stream');
  res.end(readFileSync(p));
});
await new Promise((r) => server.listen(4173, r));

// Run A's stub: the shape @tauri-apps/api 2 reads. `window.isTauri` stays
// unset, like a broken backend rather than a working app.
function installStub(marker) {
  let next = 1;
  window.__TAURI_INTERNALS__ = {
    invoke: () => Promise.reject(new Error(marker)),
    transformCallback: () => next++,
    unregisterCallback: () => {},
    convertFileSrc: (p) => p,
    metadata: {
      currentWindow: { label: 'main' },
      currentWebview: { windowLabel: 'main', label: 'main' },
    },
  };
  window.__TAURI_EVENT_PLUGIN_INTERNALS__ = { unregisterListener() {} };
}

const browser = await chromium.launch();

async function run(withStub) {
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  if (withStub) await page.addInitScript(installStub, MARKER);
  await page.goto('http://localhost:4173/');
  await page.waitForTimeout(3000);
  const rootLen = await page.evaluate(() => document.getElementById('root')?.innerHTML.length ?? 0);
  await page.close();
  return { rootLen, errors };
}

const a = await run(true);
const b = await run(false);
await browser.close();
server.close();

let failed = false;
const fatalA = a.errors.filter((e) => !e.includes(MARKER));
if (a.rootLen < 100 || fatalA.length) {
  failed = true;
  console.error(`FAIL (A, stubbed IPC): root innerHTML length=${a.rootLen}; fatal errors:`);
  for (const e of fatalA) console.error(' -', e);
}
if (b.rootLen < 100 || b.errors.length) {
  failed = true;
  console.error(`FAIL (B, no Tauri): root innerHTML length=${b.rootLen}; page errors:`);
  for (const e of b.errors) console.error(' -', e);
}
if (failed) process.exit(1);
console.log(
  `OK (A, stubbed IPC): app mounted (root innerHTML length=${a.rootLen}; ` +
    `${a.errors.length} expected IPC rejections outside the app)`
);
console.log(`OK (B, no Tauri): app mounted (root innerHTML length=${b.rootLen}; no page errors)`);
