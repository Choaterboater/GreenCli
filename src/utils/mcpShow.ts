// Display cleaning for the MCP approval box. A tool name, a server name or an
// argument can carry characters that hide or reorder text on screen (bidi
// overrides, zero-width spaces, line separators), so what the user approves
// could differ from what they read. Each such character is shown as a visible
// \u{XXXX} instead. Pure: the dialog renders the result as plain React text.

// C0 except \t and \n, DEL, C1, the Arabic letter mark, zero-width and
// direction marks, bidi embeddings and overrides, line/paragraph separators,
// word joiner and invisible operators, bidi isolates, and the BOM.
const HIDDEN =
  // eslint-disable-next-line no-control-regex
  /[\u0000-\u0008\u000B-\u001F\u007F-\u009F\u061C\u200B-\u200F\u202A-\u202E\u2028\u2029\u2060-\u2069\uFEFF]/g;

const NAME_CHARS = 64;

function escape(ch: string): string {
  return `\\u{${ch.codePointAt(0)!.toString(16).toUpperCase().padStart(4, '0')}}`;
}

/** Replace C0 (except \n, \t), DEL, C1 (U+0080-009F), U+061C, U+200B-200F, U+202A-202E,
 *  U+2028-2029, U+2060-2069 and U+FEFF with a visible `\u{XXXX}`. */
export function showText(s: string): string {
  return s.replace(HIDDEN, escape);
}

/** showText, then cap at 64 characters with "…". Used for tool, server and routed names in the
 *  title and notes. */
export function showName(s: string): string {
  const shown = [...showText(s)];
  return shown.length > NAME_CHARS ? `${shown.slice(0, NAME_CHARS - 1).join('')}…` : shown.join('');
}

/** JSON.stringify(args, null, 2) through showText (JSON already escapes C0 inside strings; this
 *  catches the rest). */
export function showArgs(args: unknown): string {
  return showText(JSON.stringify(args, null, 2) ?? String(args));
}

/** "12 lines, 1.4 KB" */
export function argsSize(args: unknown): string {
  const text = JSON.stringify(args, null, 2) ?? String(args);
  const lines = text.split('\n').length;
  const bytes = new TextEncoder().encode(text).length;
  const size = bytes < 1024 ? `${bytes} bytes` : `${(bytes / 1024).toFixed(1)} KB`;
  return `${lines} line${lines === 1 ? '' : 's'}, ${size}`;
}
