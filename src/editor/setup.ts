// The one beforeMount for every Monaco editor in the app (config editor, its
// diff, the archive diff): themes, device languages, snippets, and the hover,
// quick-fix and symbol providers. Each part registers once per Monaco
// instance, so calling it on every mount is safe.

import type { BeforeMount } from '@monaco-editor/react';
import { defineEditorThemes } from '../components/editorThemes';
import { NETWORK_LANGUAGE_IDS, registerNetworkLanguages } from './networkLanguages';
import { registerSnippetCompletions } from './snippets';
import { registerEditorProviders } from './providers';

export const setupMonaco: BeforeMount = (monaco) => {
  defineEditorThemes(monaco);
  registerNetworkLanguages(monaco);
  registerSnippetCompletions(monaco, NETWORK_LANGUAGE_IDS);
  registerEditorProviders(monaco);
};
