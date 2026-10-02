// Ctrl/Cmd+click on a web address in a Monaco editor opens it in the browser
// (Monaco's own opener calls window.open, which opens nothing in Tauri 2).

import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }));
vi.mock('../utils/tauri', () => ({ isTauri: true }));
// Only the link opener is under test here.
vi.mock('../components/editorThemes', () => ({ defineEditorThemes: vi.fn() }));
vi.mock('./networkLanguages', () => ({ NETWORK_LANGUAGE_IDS: [], registerNetworkLanguages: vi.fn() }));
vi.mock('./snippets', () => ({ registerSnippetCompletions: vi.fn() }));
vi.mock('./providers', () => ({ registerEditorProviders: vi.fn() }));

import { invoke } from '@tauri-apps/api/core';
// @ts-expect-error -- Monaco ships no types for its internal modules; this is the Uri class it hands to link openers.
import { URI } from 'monaco-editor/esm/vs/base/common/uri.js';
import { setupMonaco } from './setup';

type Opener = { open(uri: unknown): boolean | Promise<boolean> };

function fakeMonaco() {
  const openers: Opener[] = [];
  const monaco = {
    editor: { registerLinkOpener: vi.fn((opener: Opener) => void openers.push(opener)) },
  };
  return { monaco, openers };
}

function mountTwice() {
  const { monaco, openers } = fakeMonaco();
  // beforeMount runs for every editor and diff editor.
  setupMonaco(monaco as never);
  setupMonaco(monaco as never);
  expect(openers).toHaveLength(1);
  return openers[0];
}

// What Monaco's link detector finds is a string; registerLinkOpener parses it.
const click = (opener: Opener, text: string) => opener.open(URI.parse(text));

beforeEach(() => {
  vi.mocked(invoke).mockReset();
  vi.mocked(invoke).mockResolvedValue(undefined);
});

describe('Monaco web links', () => {
  it.each([
    'https://example.com/a?b=1&c=2',
    'http://ntp.example.net/',
    'https://docs.example.com/x%20y#part',
  ])('%s opens in the browser', async (url) => {
    const opener = mountTwice();
    expect(await click(opener, url)).toBe(true);
    expect(invoke).toHaveBeenCalledTimes(1);
    expect(invoke).toHaveBeenCalledWith('open_url', { url });
  });

  it.each(['file:///etc/passwd', 'command:editor.action.formatDocument'])(
    '%s is left to Monaco',
    async (text) => {
      const opener = mountTwice();
      expect(await click(opener, text)).toBe(false);
      expect(invoke).not.toHaveBeenCalled();
    }
  );

  it('registers once for each Monaco instance', () => {
    const a = fakeMonaco();
    const b = fakeMonaco();
    setupMonaco(a.monaco as never);
    setupMonaco(b.monaco as never);
    expect(a.monaco.editor.registerLinkOpener).toHaveBeenCalledTimes(1);
    expect(b.monaco.editor.registerLinkOpener).toHaveBeenCalledTimes(1);
  });
});
