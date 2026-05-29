import { SearchAddon, ISearchOptions } from 'xterm-addon-search';

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
