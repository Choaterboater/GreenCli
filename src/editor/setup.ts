// The one beforeMount for every Monaco editor in the app (config editor, its
// diff, the archive diff): themes, device languages, snippets, the hover,
// quick-fix and symbol providers, and web links. Each part registers once per
// Monaco instance (web links once per window), so calling it on every mount
// is safe.

import type { BeforeMount } from '@monaco-editor/react';
import { defineEditorThemes } from '../components/editorThemes';
import { routeWindowOpenToBrowser } from '../utils/openUrl';
import { NETWORK_LANGUAGE_IDS, registerNetworkLanguages } from './networkLanguages';
import { registerSnippetCompletions } from './snippets';
import { registerEditorProviders } from './providers';

export const setupMonaco: BeforeMount = (monaco) => {
  defineEditorThemes(monaco);
  registerNetworkLanguages(monaco);
  registerSnippetCompletions(monaco, NETWORK_LANGUAGE_IDS);
  registerEditorProviders(monaco);
  // Ctrl/Cmd+click on a web address opens it in the browser, exactly as
  // written: Monaco's own opener ends in window.open (see openUrl.ts).
  routeWindowOpenToBrowser();
};
