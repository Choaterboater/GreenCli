// Capture documentation screenshots of the GreenCLI UI.
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
// and the browser with SHOT_CHROMIUM (path to a Chromium binary).

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

// SHOT_CHROMIUM points at an already-installed Chromium when Playwright's own
// download doesn't match (e.g. SHOT_CHROMIUM=/usr/bin/chromium).
const browser = await chromium.launch(
  process.env.SHOT_CHROMIUM ? { executablePath: process.env.SHOT_CHROMIUM } : {}
);
// Dark theme (the default look), and skip the one-time first-run Help popup so
// each shot shows its own screen.
const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2, colorScheme: 'dark' });
await page.addInitScript(() => {
  try {
    localStorage.setItem('greencli-help-seen-v1', '1');
  } catch {
    /* private mode: Help may open on the first shot */
  }
});

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
const clickLabel = (label) => async () => {
  await page.locator(`[aria-label="${label}"]`).first().click({ timeout: 3000 });
};
// Settings is split into groups (left rail); pick one, then scroll to a setting.
const openSettings = (group, text) => async () => {
  await page.keyboard.press('Control+Comma');
  await sleep(500);
  if (group) await page.getByRole('button', { name: group, exact: false }).first().click({ timeout: 2000 });
  await sleep(300);
  if (text) await page.getByText(text, { exact: false }).first().scrollIntoViewIfNeeded({ timeout: 2000 });
};

await capture('01-home.png');
await capture('02-quick-connect.png', press('Control+Shift+T'));
await capture('03-ai-assistant.png', press('Control+Shift+I'));
await capture('04-api-explorer.png', press('Control+Shift+A'));
await capture('05-network-intent.png', clickLabel('Network Intent'));
await capture('06-settings.png', openSettings());
await capture('07-settings-ai.png', openSettings('AI & MCP', 'Assistant tools'));
await capture('08-settings-device-rest.png', openSettings('Connections & Security', 'Verify device TLS'));
await capture('09-help.png', press('F1'));

await browser.close();
console.log('\nDone. See docs/screenshots/. Reference them in docs like:');
console.log('  ![Home](screenshots/01-home.png)');
