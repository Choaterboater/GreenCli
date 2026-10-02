// The one beforeMount for every Monaco editor in the app (config editor, its
// diff, the archive diff): themes, device languages, snippets, the hover,
// quick-fix and symbol providers, and the web-link opener. Each part
// registers once per Monaco instance, so calling it on every mount is safe.

import type { BeforeMount } from '@monaco-editor/react';
import type * as Monaco from 'monaco-editor';
import { defineEditorThemes } from '../components/editorThemes';
import { openWebLink } from '../utils/openUrl';
import { NETWORK_LANGUAGE_IDS, registerNetworkLanguages } from './networkLanguages';
import { registerSnippetCompletions } from './snippets';
import { registerEditorProviders } from './providers';

const linkOpenerSet = new WeakSet<object>();

/**
 * Ctrl/Cmd+click on a web address in an editor opens it in the browser.
 * Monaco's own opener calls window.open, which opens nothing in Tauri 2.
 * Other links (file:) return false and keep Monaco's handling: nothing.
 */
function registerWebLinkOpener(monaco: typeof Monaco): void {
  if (linkOpenerSet.has(monaco.editor)) return;
  linkOpenerSet.add(monaco.editor);
  monaco.editor.registerLinkOpener({
    open(uri) {
      if (uri.scheme !== 'http' && uri.scheme !== 'https') return false;
      // Monaco hands over a parsed Uri; this is the href its own opener
      // builds from one.
      void openWebLink(encodeURI(uri.toString(true)));
      return true;
    },
  });
}

export const setupMonaco: BeforeMount = (monaco) => {
  defineEditorThemes(monaco);
  registerNetworkLanguages(monaco);
  registerSnippetCompletions(monaco, NETWORK_LANGUAGE_IDS);
  registerEditorProviders(monaco);
  registerWebLinkOpener(monaco);
};
