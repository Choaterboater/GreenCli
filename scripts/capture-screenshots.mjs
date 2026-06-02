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

// Reload before every shot so each screenshot starts from a clean state (no panel
// focus / lingering modal leaking between captures), then run an optional setup.
async function capture(name, setup) {
  try {
    await page.goto(URL, { waitUntil: 'networkidle', timeout: 15000 });
  } catch {
    console.error(`Could not load ${URL} — is the dev server running? (npm run dev)`);
    await browser.close();
    process.exit(1);
  }
  await sleep(1000); // fonts / mount / animations
  if (setup) {
    try {
      await setup();
    } catch (e) {
      console.warn(`(${name}: setup failed — ${String(e).split('\n')[0]})`);
    }
  }
  await sleep(600);
  const file = join(outDir, name);
  await page.screenshot({ path: file });
  console.log('saved', file);
}

const press = (key) => async () => { await page.keyboard.press(key); };
const clickTitle = (title) => async () => {
  await page.locator(`[title="${title}"]`).first().click({ timeout: 3000 });
};
const openSettingsAndScroll = (text) => async () => {
  await page.keyboard.press('Control+Comma');
  await sleep(500);
  if (text) await page.getByText(text, { exact: false }).first().scrollIntoViewIfNeeded({ timeout: 2000 });
};

await capture('01-home.png');
await capture('02-quick-connect.png', press('Control+t'));
await capture('03-ai-assistant.png', press('Control+Shift+I'));
await capture('04-api-explorer.png', press('Control+Shift+A'));
await capture('05-network-intent.png', clickTitle('Network intent / desired-state assurance'));
await capture('06-settings.png', openSettingsAndScroll());
await capture('07-settings-ai.png', openSettingsAndScroll('Assistant tools'));
await capture('08-settings-device-rest.png', openSettingsAndScroll('Verify device TLS'));
await capture('09-help.png', press('F1'));

await browser.close();
console.log('\nDone. See docs/screenshots/. Reference them in docs like:');
console.log('  ![Home](screenshots/01-home.png)');
