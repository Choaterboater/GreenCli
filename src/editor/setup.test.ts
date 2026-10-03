// Ctrl/Cmd+click on a web address in a Monaco editor opens it in the browser
// exactly as written. Monaco's own opener ends in window.open, which opens
// nothing in Tauri 2; setupMonaco sends an http(s) window.open to open_url.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }));
vi.mock('../utils/tauri', () => ({ isTauri: true }));
// Only web links are under test here.
vi.mock('../components/editorThemes', () => ({ defineEditorThemes: vi.fn() }));
vi.mock('./networkLanguages', () => ({ NETWORK_LANGUAGE_IDS: [], registerNetworkLanguages: vi.fn() }));
vi.mock('./snippets', () => ({ registerSnippetCompletions: vi.fn() }));
vi.mock('./providers', () => ({ registerEditorProviders: vi.fn() }));

// The webview's own window.open, before setupMonaco replaces it.
const nativeOpen = vi.fn((..._args: unknown[]) => null);
window.open = nativeOpen as typeof window.open;

import { invoke } from '@tauri-apps/api/core';
// @ts-expect-error -- Monaco ships no types for its internal modules; this is the opener service a link click goes to.
import { OpenerService } from 'monaco-editor/esm/vs/editor/browser/services/openerService.js';
import { setupMonaco } from './setup';

type Opener = { open(target: string, options: object): Promise<boolean> };

const editorService = { openCodeEditor: vi.fn(async () => null), getFocusedCodeEditor: () => null };
const commandService = { executeCommand: vi.fn(async () => undefined) };

function mountTwice(): Opener {
  // beforeMount runs for every editor and diff editor.
  setupMonaco({} as never);
  const routed = window.open;
  setupMonaco({} as never);
  expect(window.open).toBe(routed);
  return new OpenerService(editorService, commandService) as Opener;
}

// What Monaco's link detector finds is the text as written; links.js opens it
// with these options.
const click = (opener: Opener, text: string) =>
  opener.open(text, {
    openToSide: false,
    fromUserGesture: true,
    allowContributedOpeners: true,
    allowCommands: true,
    fromWorkspace: true,
  });

beforeEach(() => {
  vi.mocked(invoke).mockReset();
  vi.mocked(invoke).mockResolvedValue(undefined);
  nativeOpen.mockClear();
});

afterEach(() => {
  editorService.openCodeEditor.mockClear();
  commandService.executeCommand.mockClear();
});

describe('Monaco web links', () => {
  it.each([
    'https://example.com/a?b=1&c=2',
    'http://ntp.example.net/',
    'https://docs.example.com/x%20y#part',
    // Escaped reserved characters stay escaped: presigned S3 / SAS links
    // carry %2B, %2F and %3D in their signatures.
    'https://h/search?q=a%2Bb',
    'https://h/a%2Fb/c',
    'https://h/x?sig=abc%3D%3D',
    'https://h/login?next=%2Fa%3Fb%3D1%26c%3D2',
    'https://bucket.s3.amazonaws.com/fw.swi?X-Amz-Signature=ab%2Bcd%2Fef%3D&X-Amz-Expires=300',
  ])('%s opens in the browser as written', async (url) => {
    const opener = mountTwice();
    expect(await click(opener, url)).toBe(true);
    expect(invoke).toHaveBeenCalledTimes(1);
    expect(invoke).toHaveBeenCalledWith('open_url', { url });
    expect(nativeOpen).not.toHaveBeenCalled();
  });

  it('file: links are left to Monaco', async () => {
    const opener = mountTwice();
    await click(opener, 'file:///etc/passwd');
    expect(invoke).not.toHaveBeenCalled();
    expect(nativeOpen).not.toHaveBeenCalled();
    expect(editorService.openCodeEditor).toHaveBeenCalledTimes(1);
  });

  it('command: links are left to Monaco', async () => {
    const opener = mountTwice();
    await click(opener, 'command:editor.action.formatDocument');
    expect(invoke).not.toHaveBeenCalled();
    expect(nativeOpen).not.toHaveBeenCalled();
    expect(commandService.executeCommand).toHaveBeenCalledWith('editor.action.formatDocument');
  });

  it('any other window.open goes to the webview', () => {
    mountTwice();
    window.open('about:blank', '_blank', 'noopener');
    window.open();
    expect(invoke).not.toHaveBeenCalled();
    expect(nativeOpen.mock.calls).toEqual([
      ['about:blank', '_blank', 'noopener'],
      [undefined, undefined, undefined],
    ]);
  });
});

describe('outside Tauri', () => {
  it('window.open is left alone (openWebLink calls it there)', async () => {
    vi.resetModules();
    vi.doMock('../utils/tauri', () => ({ isTauri: false }));
    const before = window.open;
    const { setupMonaco: setupOutside } = await import('./setup');
    setupOutside({} as never);
    expect(window.open).toBe(before);
    vi.doUnmock('../utils/tauri');
  });
});
