// Web links open in the system browser through the app's open_url command:
// in Tauri 2 the webview opens no window for window.open or target="_blank"
// (on Windows wry marks WebView2's new-window request handled), and a plain
// link loads the site in place of the app.

import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }));
vi.mock('./tauri', () => ({ isTauri: true }));

import { invoke } from '@tauri-apps/api/core';
import { Terminal } from 'xterm';
import { useToastStore } from '../store/toastStore';
import { isLinkClick, openWebLink, terminalWebLinkHandler } from './openUrl';

const click = (over: Partial<Pick<MouseEvent, 'button' | 'ctrlKey' | 'metaKey'>> = {}) =>
  ({ button: 0, ctrlKey: false, metaKey: false, ...over }) as MouseEvent;

const URL_TEXT = 'https://example.com/a?b=1&c=2';

beforeEach(() => {
  vi.mocked(invoke).mockReset();
  vi.mocked(invoke).mockResolvedValue(undefined);
  useToastStore.setState({ toasts: [] });
});

describe('openWebLink', () => {
  it('asks the app to open the link in the browser', async () => {
    const open = vi.spyOn(window, 'open');
    await openWebLink(URL_TEXT);
    expect(invoke).toHaveBeenCalledWith('open_url', { url: URL_TEXT });
    expect(open).not.toHaveBeenCalled();
    open.mockRestore();
  });

  it('says so when the link could not be opened', async () => {
    vi.mocked(invoke).mockRejectedValue('Only http and https links open in the browser, not file: links.');
    await openWebLink('file:///etc/passwd');
    const [toast] = useToastStore.getState().toasts;
    expect(toast).toMatchObject({ kind: 'warning', title: 'Could not open link' });
    expect(toast.message).toContain('not file: links');
  });
});

describe('terminal web links', () => {
  it.each([
    ['Ctrl+click on Windows/Linux', false, click({ ctrlKey: true })],
    ['Cmd+click on macOS', true, click({ metaKey: true })],
  ])('%s opens the link', async (_name, mac, event) => {
    expect(isLinkClick(event, mac)).toBe(true);
    terminalWebLinkHandler(mac)(event, URL_TEXT);
    await Promise.resolve();
    expect(invoke).toHaveBeenCalledWith('open_url', { url: URL_TEXT });
  });

  it.each([
    ['a plain click', false, click()],
    ['a plain click on macOS', true, click()],
    ['a right-click with Ctrl', false, click({ button: 2, ctrlKey: true })],
    ['a middle click with Cmd', true, click({ button: 1, metaKey: true })],
    ['Cmd+click on Windows/Linux', false, click({ metaKey: true })],
    ['Ctrl+click on macOS (a right-click there)', true, click({ ctrlKey: true })],
  ])('%s does not', async (_name, mac, event) => {
    expect(isLinkClick(event, mac)).toBe(false);
    terminalWebLinkHandler(mac)(event, URL_TEXT);
    await Promise.resolve();
    expect(invoke).not.toHaveBeenCalled();
  });
});

describe('terminal OSC 8 hyperlinks', () => {
  // gcc, gh, claude… print links as OSC 8: text on screen, the address hidden.
  // xterm's own handler for them takes a plain click, then confirm() and
  // window.open, which open nothing in Tauri 2. Terminal.tsx passes the same
  // handler as for plain URLs (checked below).
  type Link = { text: string; activate(event: MouseEvent, text: string): void };
  type Provider = { provideLinks(y: number, callback: (links: Link[] | undefined) => void): void };
  const ADDRESS = 'https://gcc.gnu.org/onlinedocs/gcc/Warning-Options.html#index-Wunused%2Ba';

  async function oscLink(mac: boolean): Promise<Link> {
    const term = new Terminal({ linkHandler: { activate: terminalWebLinkHandler(mac) } });
    await new Promise<void>((done) =>
      term.write(`warning: unused [\x1b]8;;${ADDRESS}\x1b\\-Wunused\x1b]8;;\x1b\\]`, done),
    );
    // xterm registers its OSC 8 provider first, ahead of every addon, and a
    // link from it hides any addon link on the same text.
    const core = (term as unknown as { _core: { linkifier2: { _linkProviders: Provider[] } } })._core;
    const links = await new Promise<Link[] | undefined>((done) =>
      core.linkifier2._linkProviders[0].provideLinks(1, done),
    );
    term.dispose();
    expect(links).toHaveLength(1);
    expect(links![0].text).toBe(ADDRESS);
    return links![0];
  }

  it.each([
    ['Ctrl+click on Windows/Linux', false, click({ ctrlKey: true })],
    ['Cmd+click on macOS', true, click({ metaKey: true })],
  ])('%s opens the address', async (_name, mac, event) => {
    const confirm = vi.spyOn(window, 'confirm');
    const open = vi.spyOn(window, 'open');
    const link = await oscLink(mac);
    link.activate(event, link.text);
    await Promise.resolve();
    expect(invoke).toHaveBeenCalledTimes(1);
    expect(invoke).toHaveBeenCalledWith('open_url', { url: ADDRESS });
    expect(confirm).not.toHaveBeenCalled();
    expect(open).not.toHaveBeenCalled();
    confirm.mockRestore();
    open.mockRestore();
  });

  it.each([
    ['a plain click', false, click()],
    ['a plain click on macOS', true, click()],
    ['a right-click with Ctrl', false, click({ button: 2, ctrlKey: true })],
  ])('%s does not', async (_name, mac, event) => {
    const confirm = vi.spyOn(window, 'confirm');
    const open = vi.spyOn(window, 'open');
    const link = await oscLink(mac);
    link.activate(event, link.text);
    await Promise.resolve();
    expect(invoke).not.toHaveBeenCalled();
    expect(confirm).not.toHaveBeenCalled();
    expect(open).not.toHaveBeenCalled();
    confirm.mockRestore();
    open.mockRestore();
  });
});

describe('the app sends its web links here', () => {
  const dir = resolve(process.cwd(), 'src/components');
  const sources = readdirSync(dir)
    .filter((f) => f.endsWith('.tsx') && !f.includes('.test.'))
    .map((f) => [f, readFileSync(resolve(dir, f), 'utf8')] as const);

  it('every WebLinksAddon has a handler (its default uses window.open)', () => {
    const terminal = sources.find(([f]) => f === 'Terminal.tsx')?.[1] ?? '';
    expect(terminal.includes('new WebLinksAddon(terminalWebLinkHandler('), 'Terminal.tsx').toBe(true);
    for (const [file, text] of sources) {
      expect(/new WebLinksAddon\(\s*\)/.test(text), `${file}: WebLinksAddon with no handler`).toBe(false);
    }
  });

  it('every terminal sends OSC 8 hyperlinks to the same handler (its default uses window.open)', () => {
    let seen = 0;
    for (const [file, text] of sources) {
      let at = text.indexOf('new XTerm(');
      while (at !== -1) {
        const options = text.slice(at, text.indexOf('\n    });', at));
        expect(options, `${file}: an XTerm without linkHandler`).toContain(
          'linkHandler: { activate: terminalWebLinkHandler(isMac) },',
        );
        expect(/allowNonHttpProtocols\s*:/.test(options), `${file}: OSC 8 links other than http(s)`).toBe(false);
        seen += 1;
        at = text.indexOf('new XTerm(', at + 1);
      }
    }
    expect(seen).toBeGreaterThan(0);
  });

  it('every target="_blank" link opens through openWebLink', () => {
    let seen = 0;
    for (const [file, text] of sources) {
      let at = text.indexOf('target="_blank"');
      while (at !== -1) {
        const start = text.lastIndexOf('<a', at);
        const end = text.indexOf('</a>', at);
        expect(start, file).toBeGreaterThan(-1);
        expect(end, file).toBeGreaterThan(at);
        const anchor = text.slice(start, end);
        expect(
          /onClick=\{\(e\) => \{\s*e\.preventDefault\(\);\s*void openWebLink\(/.test(anchor),
          `${file}: a target="_blank" link without openWebLink`,
        ).toBe(true);
        seen += 1;
        at = text.indexOf('target="_blank"', at + 1);
      }
    }
    expect(seen).toBeGreaterThan(0);
  });

  it('every ReactMarkdown sends its links to openWebLink (a plain click replaces the app)', () => {
    let seen = 0;
    for (const [file, text] of sources) {
      let at = text.indexOf('<ReactMarkdown');
      while (at !== -1) {
        const end = text.indexOf('</ReactMarkdown>', at);
        expect(end, file).toBeGreaterThan(at);
        expect(
          /\ba\(\{[^)]*\bhref\b[^)]*\}\) \{[^]*?onClick=\{\(e\) => \{\s*e\.preventDefault\(\);\s*if \(href\) void openWebLink\(href\);/.test(
            text.slice(at, end),
          ),
          `${file}: a ReactMarkdown without an a component that calls openWebLink`,
        ).toBe(true);
        // A middle click sends auxclick, not click, and the webview follows the link.
        expect(
          /\ba\(\{[^)]*\bhref\b[^)]*\}\) \{[^]*?onAuxClick=\{\(e\) => \{\s*if \(e\.button !== 1\) return;\s*e\.preventDefault\(\);/.test(
            text.slice(at, end),
          ),
          `${file}: a ReactMarkdown link without an onAuxClick that stops a middle click`,
        ).toBe(true);
        seen += 1;
        at = text.indexOf('<ReactMarkdown', end);
      }
    }
    expect(seen).toBeGreaterThan(0);
  });

  it('Monaco editors open web links through openWebLink (its default uses window.open)', () => {
    // setup.test.ts checks what a link click does; here, that every editor gets it.
    const setup = readFileSync(resolve(process.cwd(), 'src/editor/setup.ts'), 'utf8');
    const setupMonaco = setup.slice(setup.indexOf('export const setupMonaco'));
    expect(setupMonaco.slice(0, setupMonaco.indexOf('\n};')), 'setupMonaco').toContain('routeWindowOpenToBrowser();');
    // A link opener gets a parsed Uri, with %2B, %2F, %3D … already decoded.
    expect(setup, 'setup.ts: registerLinkOpener').not.toContain('registerLinkOpener');
    let editors = 0;
    for (const [file, text] of sources) {
      const count = (text.match(/<(?:Diff)?Editor\b/g) ?? []).length;
      const setUp = (text.match(/beforeMount=\{setupMonaco\}/g) ?? []).length;
      expect(setUp, `${file}: a Monaco editor without beforeMount={setupMonaco}`).toBe(count);
      editors += count;
    }
    expect(editors).toBeGreaterThan(0);
  });
});
