// Turns text selected in a session into an editor tab: tidy line ends, no
// blank lines at the edges, and the session's device language so the editor
// colors (and checks) it like a config.

import type { EditorDraft } from '../store/editorInboxStore';

/** Selections bigger than this are cut, so a select-all of a huge scrollback can't stall the editor. */
export const MAX_DRAFT_CHARS = 2_000_000;

export function draftFromSelection(selection: string, sessionName: string, deviceType: string | null): EditorDraft | null {
  const lines = selection
    .slice(0, MAX_DRAFT_CHARS)
    .replace(/\r\n?/g, '\n')
    .split('\n')
    // xterm pads a selected row with spaces out to the selection's edge.
    .map((line) => line.replace(/[ \t]+$/, ''));
  while (lines.length && !lines[0].trim()) lines.shift();
  while (lines.length && !lines[lines.length - 1].trim()) lines.pop();
  if (!lines.length) return null;
  return {
    name: `${sessionName} (selection)`,
    content: `${lines.join('\n')}\n`,
    // Generic sessions open as plain text; the editor's own detection picks a vendor from the text.
    language: deviceType && deviceType !== 'generic' ? deviceType : 'plaintext',
  };
}
