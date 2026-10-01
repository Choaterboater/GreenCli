import type { BeforeMount } from '@monaco-editor/react';

// Monaco editor themes for the config editor and the archive diff. Monaco
// wants literal hex (it can't read CSS variables), so this is the one place
// these colours live — like the xterm schemes, a fixed palette per theme.
// Monaco has one theme for every editor, and defineTheme replaces it globally:
// the archive used to register a shorter copy under the same names, which
// swapped the open editor's syntax colours for the base theme's.
// Registered via beforeMount on every <Editor>/<DiffEditor> so the
// prop-driven theme (which follows the app's light/dark setting) resolves.

export const defineEditorThemes: BeforeMount = (monaco) => {
  monaco.editor.defineTheme('aruba-dark', {
    base: 'vs-dark',
    inherit: true,
    rules: [
      { token: 'comment', foreground: '6a737d', fontStyle: 'italic' },
      { token: 'keyword', foreground: 'e06c75' },
      { token: 'number', foreground: '56b6c2' },
      { token: 'number.float', foreground: '98c379' },
      { token: 'type', foreground: 'e5c07b' },
      { token: 'string', foreground: 'abb2bf' },
      // Template blanks and hidden-secret markers that still need a value.
      { token: 'variable', foreground: 'f0a83c', fontStyle: 'bold' },
    ],
    colors: {
      'editor.background': '#0d1117',
      'editor.foreground': '#c9d1d9',
      'editor.lineHighlightBackground': '#161b2240',
      'editor.selectionBackground': '#264f7880',
      'editorLineNumber.foreground': '#484f58',
      'editorLineNumber.activeForeground': '#8b949e',
      'editorCursor.foreground': '#58a6ff',
      'editorWhitespace.foreground': '#30363d',
      'editorIndentGuide.background': '#21262d',
      'editorIndentGuide.activeBackground': '#30363d',
      'scrollbarSlider.background': '#21262d80',
      'scrollbarSlider.hoverBackground': '#30363d',
    },
  });
  monaco.editor.defineTheme('aruba-light', {
    base: 'vs',
    inherit: true,
    rules: [
      { token: 'comment', foreground: '6e7781', fontStyle: 'italic' },
      { token: 'keyword', foreground: 'cf222e' },
      { token: 'number', foreground: '0e7490' },
      { token: 'number.float', foreground: '1a7f37' },
      { token: 'type', foreground: '9a6700' },
      { token: 'string', foreground: '57606a' },
      { token: 'variable', foreground: '9a3412', fontStyle: 'bold' },
    ],
    colors: {
      'editor.background': '#ffffff',
      'editor.foreground': '#1f2328',
      'editor.lineHighlightBackground': '#f4f7f980',
      'editor.selectionBackground': '#add6ff80',
      'editorLineNumber.foreground': '#8c959f',
      'editorLineNumber.activeForeground': '#57606a',
      'editorCursor.foreground': '#0969da',
      'editorWhitespace.foreground': '#d0d7de',
      'editorIndentGuide.background': '#eaeef2',
      'editorIndentGuide.activeBackground': '#d0d7de',
      'scrollbarSlider.background': '#d0d7de80',
      'scrollbarSlider.hoverBackground': '#afb8c1',
    },
  });
};
