// Capture documentation screenshots of the HPE Network Terminal UI.
//
// Usage:
//   1. Start the UI dev server:   npm run dev        (serves http://localhost:1420)
//   2. Install Playwright once:   npm i -D playwright && npx playwright install chromium
//   3. Run this script:           node scripts/capture-screenshots.mjs
//
// Images are written to docs/screenshots/. The dev server runs the UI WITHOUT the
// Rust backend, so backend-driven panels show their empty states (good for layout
// docs). For screenshots with live data, run `npm run tauri-dev` and grab the native
// window with your OS screenshot tool instead.
//
// Override the URL with SHOT_URL, e.g. SHOT_URL=http://localhost:5173 node scripts/...

import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { mkdirSync } from 'node:fs';

const URL = process.env.SHOT_URL || 'http://localhost:1420';
const here = dirname(fileURLToPath(import.meta.url));
const outDir = join(here, '..', 'docs', 'screenshots');
mkdirSync(outDir, { recursive: true });

let chromium;
try {
  ({ chromium } = await import('playwright'));
} catch {
  console.error('Playwright is not installed. Run:  npm i -D playwright && npx playwright install chromium');
  process.exit(1);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2 });

try {
  await page.goto(URL, { waitUntil: 'networkidle', timeout: 15000 });
} catch (e) {
  console.error(`Could not load ${URL} — is the dev server running? (npm run dev)`);
  await browser.close();
  process.exit(1);
}
await sleep(1200); // let fonts/animations settle

const shot = async (name) => {
  const file = join(outDir, name);
  await page.screenshot({ path: file });
  console.log('saved', file);
};

// 1. Home / empty state
await shot('01-home.png');

// 2. Quick Connect (Ctrl+T)
await page.keyboard.press('Control+t');
await sleep(600);
await shot('02-quick-connect.png');
await page.keyboard.press('Escape');
await sleep(300);

// 3. Settings (Ctrl+,)
await page.keyboard.press('Control+Comma');
await sleep(600);
await shot('03-settings.png');
await page.keyboard.press('Escape');
await sleep(300);

// Add more screens here as needed — e.g. click the title-bar AI / Intent / API
// buttons by their title attribute, then call shot('04-....png').

await browser.close();
console.log('\nDone. See docs/screenshots/. Reference them in docs with:');
console.log('  ![Home](screenshots/01-home.png)');
