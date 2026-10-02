// Monaco hookups for the device languages: hover cards. Registered once per
// Monaco instance from setupMonaco (beforeMount), like the snippets: the
// editor's onMount runs again after every Diff toggle.

import type * as Monaco from 'monaco-editor';
import { CARD_LANGUAGES, cardForLine, cardMarkdown } from './commandCards';

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
}
