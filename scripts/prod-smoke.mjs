// Production-bundle smoke test: serves dist/ and verifies the app actually
// mounts. Catches startup crashes the dev-server e2e can't see — chunk
// evaluation-order bugs in the minified build render as a white screen in the
// packaged app (this exact failure shipped in v1.2.1).
//
// Usage: npm run build && node scripts/prod-smoke.mjs
import { chromium } from '@playwright/test';
import { createServer } from 'http';
import { readFileSync, existsSync } from 'fs';
import { join, resolve, sep, extname, dirname } from 'path';
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

const server = createServer((req, res) => {
  // Resolve against DIST and confine the result to it. join() normalizes a raw
  // `..` request path away, so without this check any file readable by this
  // user (~/.ssh, .env, …) was served for the lifetime of the smoke run.
  let p = resolve(DIST, '.' + (req.url.split('?')[0] === '/' ? '/index.html' : req.url.split('?')[0]));
  if (p !== DIST && !p.startsWith(DIST + sep)) p = join(DIST, 'index.html');
  if (!existsSync(p)) p = join(DIST, 'index.html');
  res.setHeader('content-type', MIME[extname(p)] || 'application/octet-stream');
  try {
    res.end(readFileSync(p));
  } catch {
    // Directory requests (EISDIR) and read races are a 404, not a crashed run.
    res.statusCode = 404;
    res.end('not found');
  }
});
// Loopback only — this server also runs on shared CI runners and jump hosts.
await new Promise((r) => server.listen(4173, '127.0.0.1', r));

const browser = await chromium.launch();
const page = await browser.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
await page.goto('http://localhost:4173/');
await page.waitForTimeout(3000);
const rootLen = await page.evaluate(() => document.getElementById('root')?.innerHTML.length ?? 0);
await browser.close();
server.close();

// Tauri IPC rejections are expected outside the real app; anything else is not.
const fatal = errors.filter((e) => !e.includes('__TAURI_IPC__') && !e.includes('__TAURI_METADATA__'));
if (rootLen < 100 || fatal.length) {
  console.error(`FAIL: root innerHTML length=${rootLen}; fatal errors:`);
  for (const e of fatal) console.error(' -', e);
  process.exit(1);
}
console.log(`OK: app mounted (root innerHTML length=${rootLen}; ${errors.length} expected non-Tauri IPC rejections)`);
