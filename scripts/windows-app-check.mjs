// Windows app check: starts the built GreenCLI with a throwaway home folder
// and checks the real app, not a mock:
//  1. the window renders;
//  2. Settings offers to import the servers in a fake Claude Desktop config
//     (%APPDATA%\Claude\claude_desktop_config.json in the throwaway home);
//  3. greencli-mcp reaches the app over its named pipe, after the secret
//     check, and lists no devices;
//  4. after a crash, a pipe that takes the old name but doesn't know the
//     secret gets no request, and greencli-mcp says GreenCLI isn't open;
//  5. GreenCLI started again over the stale file answers again.
//
// The build uses its own app id (com.choatelabs.greencli.check), so it never
// opens a real GreenCLI's data or password store entries. Its data, the
// WebView2 data and the fake config all sit in the temp folder: Windows finds
// %APPDATA% and %LOCALAPPDATA% from USERPROFILE, which points there.
//
// Usage (Windows):
//   node scripts/windows-app-check.mjs --build   (debug build with that app id, then the check)
//   node scripts/windows-app-check.mjs           (check the last build)
// --build replaces src-tauri/target/debug/GreenCLI.exe with the check build.
import { chromium } from '@playwright/test';
import { execFileSync, spawn, spawnSync } from 'child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { createServer } from 'net';
import { tmpdir } from 'os';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const TAURI = join(ROOT, 'src-tauri');
const TARGET = process.env.CARGO_TARGET_DIR || join(TAURI, 'target');
const APP = join(TARGET, 'debug', 'GreenCLI.exe');
const MCP = join(TARGET, 'debug', 'greencli-mcp.exe');
const APP_ID = 'com.choatelabs.greencli.check';
const CDP_PORT = 9333;
const NOT_OPEN = "GreenCLI isn't open";

if (process.platform !== 'win32') {
  console.log('Windows only: nothing to check here.');
  process.exit(0);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function until(what, fn, ms = 60_000) {
  const end = Date.now() + ms;
  for (;;) {
    const got = await fn().catch(() => undefined);
    if (got) return got;
    if (Date.now() > end) throw new Error(`timed out: ${what}`);
    await sleep(500);
  }
}

function build() {
  const conf = JSON.parse(readFileSync(join(TAURI, 'tauri.conf.json'), 'utf8'));
  const windows = conf.app.windows.map((w) => ({
    ...w,
    additionalBrowserArgs: `--disable-features=msWebOOUI,msPdfOOUI,msSmartScreenProtection --remote-debugging-port=${CDP_PORT}`,
  }));
  const override = { identifier: APP_ID, build: { beforeBuildCommand: '' }, app: { windows } };
  const run = (cmd, args, cwd) => {
    const r = spawnSync(cmd, args, { cwd, stdio: 'inherit' });
    if (r.status !== 0) throw new Error(`${cmd} ${args[0]} failed`);
  };
  const confFile = join(mkdtempSync(join(tmpdir(), 'greencli-conf-')), 'check.conf.json');
  writeFileSync(confFile, JSON.stringify(override));
  const tauriCli = join(ROOT, 'node_modules', '@tauri-apps', 'cli', 'tauri.js');
  run(process.execPath, [tauriCli, 'build', '--debug', '--no-bundle', '--config', confFile], ROOT);
  rmSync(dirname(confFile), { recursive: true, force: true });
  run('cargo', ['build', '-p', 'greencli-mcp'], TAURI);
}

/** Send greencli-mcp one tool call; the text of its answer. */
function mcpCall(dataDir, name, args = {}) {
  const lines = [
    { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'check', version: '0' } } },
    { jsonrpc: '2.0', method: 'notifications/initialized' },
    { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name, arguments: args } },
  ];
  const out = execFileSync(MCP, ['--data-dir', dataDir], {
    input: lines.map((l) => JSON.stringify(l)).join('\n') + '\n',
    encoding: 'utf8',
    timeout: 30_000,
  });
  const reply = out.split('\n').filter(Boolean).map((l) => JSON.parse(l)).find((m) => m.id === 2);
  return reply.result.content[0].text;
}

function startApp(home) {
  const env = {
    ...process.env,
    HOME: home,
    USERPROFILE: home,
    APPDATA: join(home, 'AppData', 'Roaming'),
    LOCALAPPDATA: join(home, 'AppData', 'Local'),
  };
  const app = spawn(APP, [], { env, stdio: 'ignore' });
  app.on('error', (e) => console.error(`couldn't start GreenCLI: ${e.message}`));
  return app;
}

async function page() {
  const browser = await until('the GreenCLI window (WebView2 debug port)', () =>
    chromium.connectOverCDP(`http://127.0.0.1:${CDP_PORT}`),
  );
  const p = await until('the GreenCLI page', async () =>
    browser.contexts()[0]?.pages().find((x) => x.url().startsWith('https://tauri.localhost')),
  );
  return { browser, page: p };
}

function stop(app) {
  if (app.exitCode === null) spawnSync('taskkill', ['/PID', String(app.pid), '/T', '/F'], { stdio: 'ignore' });
}

const results = [];
function check(name, ok, detail = '') {
  results.push(ok);
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${detail ? `: ${detail}` : ''}`);
}

async function main() {
  if (process.argv.includes('--build')) build();
  for (const f of [APP, MCP]) if (!existsSync(f)) throw new Error(`${f} is missing: run with --build`);

  const home = mkdtempSync(join(tmpdir(), 'greencli-check-'));
  for (const d of ['AppData/Roaming/Claude', 'AppData/Local', 'Desktop', 'Documents']) {
    mkdirSync(join(home, d), { recursive: true });
  }
  writeFileSync(
    join(home, 'AppData', 'Roaming', 'Claude', 'claude_desktop_config.json'),
    JSON.stringify({ mcpServers: { 'check-notes': { command: 'node', args: ['C:/fake/notes.js'], env: { NOTES_TOKEN: 'fake' } } } }),
  );
  const dataDir = join(home, 'AppData', 'Roaming', APP_ID);
  const sock = join(dataDir, 'mcp-live.sock');
  let app = startApp(home);
  try {
    // 1. The window renders.
    const { browser, page: p } = await page();
    await until('the main window', async () => (await p.getByRole('button', { name: 'Quick Connect' }).count()) > 0);
    check('the window renders', true);

    // 2. The import offer finds the fake Claude Desktop server.
    await p.keyboard.press('Escape');
    await p.getByRole('button', { name: 'Settings' }).first().click();
    const offer = await until('the MCP import offer', async () => {
      const t = await p.evaluate(() => document.body.innerText);
      return t.includes('Use MCP servers you already set up?') && t;
    }, 20_000).catch(() => '');
    check('Settings offers the Claude Desktop server', offer.includes('check-notes (Claude Desktop)'));
    await browser.close().catch(() => {});

    // 3. greencli-mcp over the named pipe.
    await until('mcp-live.sock in the throwaway data folder', async () => existsSync(sock));
    const listed = await until('a live answer', async () => {
      const t = mcpCall(dataDir, 'list_connected_devices');
      return t.includes('"devices"') && t;
    }, 20_000).catch((e) => String(e));
    check('greencli-mcp lists devices over the pipe', listed === '{"devices":[]}', listed);

    // 4. After a crash, a pipe that takes the old name gets nothing.
    stop(app);
    await sleep(1000);
    const name = readFileSync(sock, 'utf8').split('\n')[0].trim();
    let received = 0;
    const squatter = createServer((s) => {
      s.on('error', () => {});
      s.on('data', (d) => (received += d.length));
      s.write(`{"v":1,"greencli":"${'0'.repeat(64)}"}\n{"ok":true,"devices":[{"tabId":"x","name":"fake","type":"aruba-cx"}]}\n`);
    });
    await new Promise((r) => squatter.listen(`\\\\.\\pipe\\${name}`, r));
    const squatted = mcpCall(dataDir, 'device_show', { device: 'fake', show: 'show version' });
    await sleep(500);
    await new Promise((r) => squatter.close(r));
    check('a pipe without the secret gets no request', received === 0, `${received} bytes`);
    check('greencli-mcp says GreenCLI is not open', squatted.includes(NOT_OPEN), squatted);

    // 5. Started again over the stale file, GreenCLI answers again.
    app = startApp(home);
    const again = await until('a live answer after the restart', async () => {
      const t = mcpCall(dataDir, 'list_connected_devices');
      return t.includes('"devices"') && t;
    }).catch((e) => String(e));
    check('GreenCLI answers again after a crash', again === '{"devices":[]}', again);
  } finally {
    stop(app);
    await sleep(1000);
    try {
      rmSync(home, { recursive: true, force: true });
    } catch {
      // WebView2 can hold its folder for a moment; the temp folder is the OS's to clean.
    }
  }
  if (results.includes(false)) process.exit(1);
}

main().catch((e) => {
  console.error(`FAIL ${e.message}`);
  process.exit(1);
});
