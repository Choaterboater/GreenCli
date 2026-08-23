// Local Monaco wiring — removes the runtime CDN dependency.
//
// @monaco-editor/react's default loader pulls monaco-editor's AMD build from
// `cdn.jsdelivr.net` at runtime, which is exactly why the CSP whitelisted that
// origin (NW-20 residual BH-1). This module flips the loader to the NPM-bundled
// ESM build and points every worker at Vite's `?worker` chunks, so the built
// app (and the CSP) is fully `'self'` — no third-party origin anywhere.
import { loader } from '@monaco-editor/react';
import * as monaco from 'monaco-editor';
import editorWorker from 'monaco-editor/esm/vs/editor/editor.worker?worker';
import jsonWorker from 'monaco-editor/esm/vs/language/json/json.worker?worker';
import cssWorker from 'monaco-editor/esm/vs/language/css/css.worker?worker';
import htmlWorker from 'monaco-editor/esm/vs/language/html/html.worker?worker';
import tsWorker from 'monaco-editor/esm/vs/language/typescript/ts.worker?worker';

import type { Environment } from 'monaco-editor';

self.MonacoEnvironment = {
  getWorker(workerId: string) {
    switch (workerId) {
      case 'json':
        return new jsonWorker();
      case 'css':
      case 'scss':
      case 'less':
        return new cssWorker();
      case 'html':
      case 'handlebars':
      case 'razor':
        return new htmlWorker();
      case 'typescript':
      case 'javascript':
        return new tsWorker();
      default:
        return new editorWorker();
    }
  },
} satisfies Environment;

// Replace the CDN loader with the local ESM build, then let every
// <Editor>/<DiffEditor> instantiate monaco synchronously from it.
loader.config({ monaco });