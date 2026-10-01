// The single exit point for AI tool results: every tool's raw output passes
// through prepareToolResult before the model sees it. Secrets are hidden
// first, then the result is capped (cutting first could drop a PEM BEGIN or a
// "snmp {" line and leak what follows it). If the filter can't run on this
// system the output is withheld, never sent unchecked.

import { secretFilterSupported } from './support';

/** A tool's output before any hiding or capping. */
export type RawToolOutcome =
  | { kind: 'text'; text: string; isError: boolean }
  | { kind: 'json'; value: unknown }
  | { kind: 'terminal'; output: string; command: string; truncated: boolean };

export const rawOk = (text: string): RawToolOutcome => ({ kind: 'text', text, isError: false });
export const rawErr = (text: string): RawToolOutcome => ({ kind: 'text', text, isError: true });
/** A REST result (an object) or MCP result (text that often holds JSON). */
export const rawJson = (value: unknown): RawToolOutcome => ({ kind: 'json', value });
/** Output captured from the live terminal after sending `command`. */
export const rawTerminal = (output: string, command: string, truncated: boolean): RawToolOutcome => ({
  kind: 'terminal',
  output,
  command,
  truncated,
});

/** What the model receives, plus a note for the tool row when secrets were hidden. */
export interface PreparedToolResult {
  text: string;
  isError: boolean;
  note?: string;
}

/** Characters the model gets per tool result. */
export const TOOL_RESULT_CAP = 12_000;
/** Text past this is cut before scrubbing (JSON is parsed first), so a runaway result can't freeze the UI. */
export const MAX_SCRUB_CHARS = 1_000_000;

export const WITHHELD_TEXT =
  'The tool ran, but its output is not shown: GreenCLI could not check it for device secrets on this system.';
const WITHHELD_NOTE = 'Output withheld: the secret filter cannot run on this system.';

/** Keep the start; say how much was cut so the model doesn't treat a sliced JSON document as complete. */
export function capHead(text: string, max = TOOL_RESULT_CAP): string {
  return text.length > max ? `${text.slice(0, max)}\n…(truncated ${text.length - max} more chars)` : text;
}

/** Keep the end (the most relevant part of terminal output). */
export function capTail(text: string, max = TOOL_RESULT_CAP): string {
  return text.length > max ? `…(truncated)…\n${text.slice(-max)}` : text;
}

/** The device echoes the command first, so output that starts with the echo
 *  starts at the top (a capture cut at the settle cap is missing its end, not
 *  its start). Output without it (a pager page, a trimmed buffer) may start
 *  inside a config block. */
function startsWithEcho(output: string, command: string): boolean {
  const first = command.split('\n').find((line) => line.trim())?.trim();
  if (!first) return false;
  const firstLine = output.trimStart().split('\n', 1)[0] ?? '';
  return firstLine.includes(first);
}

/** Deeper than this, the copied JSON walk stops looking (it passes the rest
 *  through), so a result nested this deep is withheld instead. */
export const MAX_JSON_DEPTH = 60;

function deeperThan(value: unknown, limit: number): boolean {
  if (!value || typeof value !== 'object') return false;
  if (limit <= 0) return true;
  return Object.values(value).some((entry) => deeperThan(entry, limit - 1));
}

/** The value to scrub. MCP text holding JSON is parsed here to check its depth,
 *  and oversized text is parsed before anything is cut: a cut JSON document no
 *  longer parses, and its secret-named keys would go unchecked. */
function jsonInput(value: unknown): unknown {
  let parsed: unknown = value;
  if (typeof value === 'string') {
    try {
      parsed = /^\s*[[{]/.test(value) ? JSON.parse(value) : undefined;
    } catch {
      parsed = undefined;
    }
  }
  if (deeperThan(parsed, MAX_JSON_DEPTH)) throw new Error('result nested too deep to check');
  if (typeof value !== 'string' || value.length <= MAX_SCRUB_CHARS) return value;
  return parsed ?? value.slice(0, MAX_SCRUB_CHARS);
}

const withHint = (text: string, hint: string | undefined) => (hint ? `${text}\n${hint}` : text);

export async function prepareToolResult(raw: RawToolOutcome): Promise<PreparedToolResult> {
  const isError = raw.kind === 'text' && raw.isError;
  if (raw.kind === 'terminal' && !raw.output) {
    const empty = `Command \`${raw.command}\` sent — no output captured (may be interactive, paged, or still running).`;
    return { text: raw.truncated ? `[capture may be truncated]\n${empty}` : empty, isError: false };
  }
  try {
    if (!secretFilterSupported()) throw new Error('secret filter unsupported');
    const engine = await import('./engine');
    let text: string;
    let hidden: number;
    let kinds: Parameters<typeof engine.hiddenNote>[1];
    if (raw.kind === 'json') {
      const result = engine.scrubJsonForAi(jsonInput(raw.value));
      ({ hidden, kinds } = result);
      const value = result.value;
      text = capHead(typeof value === 'string' ? value : (JSON.stringify(value, null, 2) ?? String(value)));
    } else if (raw.kind === 'terminal') {
      const sliced = raw.output.length > MAX_SCRUB_CHARS;
      const output = sliced ? raw.output.slice(-MAX_SCRUB_CHARS) : raw.output;
      const cutHead = sliced || !startsWithEcho(output, raw.command);
      const result = engine.scrubForAi(output, { cutHead });
      ({ hidden, kinds } = result);
      const body = withHint(capTail(result.text), hidden ? engine.defaultCommunityHint(output) : undefined);
      text = raw.truncated || sliced ? `[capture may be truncated]\n${body}` : body;
    } else {
      const input = raw.text.slice(0, MAX_SCRUB_CHARS);
      const result = engine.scrubForAi(input);
      ({ hidden, kinds } = result);
      text = withHint(capHead(result.text), hidden ? engine.defaultCommunityHint(input) : undefined);
    }
    const note = engine.hiddenNote(hidden, kinds);
    return { text, isError, ...(note ? { note } : {}) };
  } catch {
    return { text: WITHHELD_TEXT, isError: true, note: WITHHELD_NOTE };
  }
}
