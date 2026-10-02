// Monaco hookups for the device languages: hover cards, quick fixes (Ctrl+.
// or the light bulb, from the problems' markers) and the symbols Go to Symbol
// (Ctrl+Shift+O) lists. Registered once per
// Monaco instance from setupMonaco (beforeMount), like the snippets: the
// editor's onMount runs again after every Diff toggle.

import type * as Monaco from 'monaco-editor';
import { CARD_LANGUAGES, cardForLine, cardMarkdown } from './commandCards';
import { quickFixesFor } from './quickFixes';
import { configSymbols, type ConfigSymbolKind } from './configSymbols';
import { NETWORK_LANGUAGE_IDS } from './networkLanguages';

const registered = new WeakSet<object>();

export function registerEditorProviders(monaco: typeof Monaco): void {
  if (registered.has(monaco.languages)) return;
  registered.add(monaco.languages);

  for (const language of CARD_LANGUAGES) {
    monaco.languages.registerHoverProvider(language, {
      provideHover(model, position) {
        const line = model.getLineContent(position.lineNumber);
        const card = cardForLine(line, language);
        if (!card) return null;
        const start = line.length - line.trimStart().length + 1;
        return {
          range: new monaco.Range(position.lineNumber, start, position.lineNumber, line.trimEnd().length + 1),
          contents: [{ value: cardMarkdown(card, language) }],
        };
      },
    });
  }

  const kinds: Record<ConfigSymbolKind, Monaco.languages.SymbolKind> = {
    interface: monaco.languages.SymbolKind.Interface,
    lag: monaco.languages.SymbolKind.Struct,
    vlan: monaco.languages.SymbolKind.Enum,
    routing: monaco.languages.SymbolKind.Namespace,
    section: monaco.languages.SymbolKind.Module,
  };
  for (const language of NETWORK_LANGUAGE_IDS) {
    monaco.languages.registerDocumentSymbolProvider(language, {
      displayName: 'GreenCLI config',
      provideDocumentSymbols(model) {
        return configSymbols(model.getValue(), language).map((symbol) => ({
          name: symbol.name,
          detail: '',
          kind: kinds[symbol.kind],
          tags: [],
          range: new monaco.Range(symbol.line, 1, symbol.endLine, model.getLineMaxColumn(symbol.endLine)),
          selectionRange: new monaco.Range(symbol.line, 1, symbol.line, model.getLineMaxColumn(symbol.line)),
        }));
      },
    });
  }

  // Any language: the terminal-junk problem shows up in code files too. Only
  // GreenCLI's own markers (source "GreenCLI", set by ConfigEditor) get fixes.
  monaco.languages.registerCodeActionProvider(
    '*',
    {
      provideCodeActions(model, _range, context) {
        const text = model.getValue();
        const language = model.getLanguageId();
        const seen = new Set<string>();
        const actions: Monaco.languages.CodeAction[] = [];
        for (const marker of context.markers) {
          const code = typeof marker.code === 'string' ? marker.code : marker.code?.value;
          if (marker.source !== 'GreenCLI' || !code) continue;
          const spot = { lineNumber: marker.startLineNumber, startColumn: marker.startColumn, endColumn: marker.endColumn, code };
          for (const fix of quickFixesFor(spot, text, language)) {
            if (seen.has(fix.title)) continue;
            seen.add(fix.title);
            actions.push({
              title: fix.title,
              kind: 'quickfix',
              diagnostics: [marker],
              isPreferred: fix.preferred,
              edit: {
                edits: fix.edits.map((edit) => ({
                  resource: model.uri,
                  versionId: model.getVersionId(),
                  textEdit: {
                    range: new monaco.Range(edit.startLineNumber, edit.startColumn, edit.endLineNumber, edit.endColumn),
                    text: edit.text,
                  },
                })),
              },
            });
          }
        }
        return { actions, dispose() {} };
      },
    },
    { providedCodeActionKinds: ['quickfix'] }
  );
}
