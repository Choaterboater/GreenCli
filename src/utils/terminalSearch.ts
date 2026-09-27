import { SearchAddon, ISearchOptions } from 'xterm-addon-search';
import { useSessionStore } from '../store/sessionStore';

export interface ISearchAdapter {
  findNext(term: string, opts?: ISearchOptions): boolean;
  findPrevious(term: string, opts?: ISearchOptions): boolean;
  clearDecorations(): void;
  clearActiveDecoration(): void;
  onResultsChange(cb: (r: { resultIndex: number; resultCount: number }) => void): () => void;
}

const DECORATIONS = {
  matchBackground: '#2d4f7c',
  matchBorder: '#388bfd',
  matchOverviewRuler: '#388bfd',
  activeMatchBackground: '#f0b429',
  activeMatchBorder: '#f0b429',
  activeMatchColorOverviewRuler: '#f0b429',
};

const registry = new Map<string, ISearchAdapter>();

export function registerSearchAdapter(sessionId: string, adapter: ISearchAdapter): void {
  registry.set(sessionId, adapter);
}

export function unregisterSearchAdapter(sessionId: string): void {
  registry.delete(sessionId);
}

export function getSearchAdapter(sessionId: string): ISearchAdapter | undefined {
  return registry.get(sessionId);
}

export function createSearchAdapter(addon: SearchAddon): ISearchAdapter {
  return {
    findNext(term, opts) {
      return addon.findNext(term, { decorations: DECORATIONS, ...opts });
    },
    findPrevious(term, opts) {
      return addon.findPrevious(term, { decorations: DECORATIONS, ...opts });
    },
    clearDecorations() {
      addon.clearDecorations();
    },
    clearActiveDecoration() {
      addon.clearActiveDecoration();
    },
    onResultsChange(cb) {
      const disposable = addon.onDidChangeResults(cb);
      return () => disposable.dispose();
    },
  };
}

// ── Find bar commands ───────────────────────────────────────────────────
// The Find bar (SearchOverlay) owns its query and input focus; the keyboard
// shortcuts and the terminal's right-click menu reach it through these
// commands instead of prop-drilling. SearchOverlay stays mounted while hidden,
// so it hears a command sent in the same tick as the "open" state change.

export type SearchCommand =
  | { type: 'focus'; prefill?: string }
  | { type: 'next' }
  | { type: 'prev' };

const commandListeners = new Set<(cmd: SearchCommand) => void>();

export function onSearchCommand(cb: (cmd: SearchCommand) => void): () => void {
  commandListeners.add(cb);
  return () => {
    commandListeners.delete(cb);
  };
}

export function sendSearchCommand(cmd: SearchCommand): void {
  commandListeners.forEach((cb) => cb(cmd));
}

/**
 * Open the Find bar — or, if it is already open, put the cursor back in its
 * input with the text selected (pressing Find again should never be a no-op).
 * `prefill` searches for that text right away ("Find selection").
 */
export function openTerminalSearch(prefill?: string): void {
  useSessionStore.getState().setShowSearch(true);
  sendSearchCommand({ type: 'focus', prefill });
}
