// GreenCLI's secret filter, built from the Casper rules copied next to this
// file. Loaded only through forAi.ts's dynamic import(): the rules use regex
// lookbehind, and a WebView that can't parse them must fail closed, not crash
// the app at startup.

import { scrubAssignments, scrubUrlPasswords } from './assignments';
import { LINE_MARKER } from './markers';
import { KIND_ORDER, PEM_BEGIN, PEM_END, type SecretKind } from './patterns';
import { scrubProseSecrets } from './prose';
import { scrubText, scrubValue, type ScrubTextResult, type ScrubValueResult } from './scrub';

export { hiddenNote } from './scrub';

// AOS-8 `--More-- (q) quit…`, AOS-S/CX `-- MORE --, next page: Space…`, Junos
// `---(more 42%)---`, then a bare `--More--` (longest first: the first form
// that matches wins). A device that erases its pager prompt with backspaces
// leaves the prompt and the next config line on one line once the control
// characters are stripped, and line-start rules (mgmt-user, username …) would
// miss that line.
const PAGER_PROMPT =
  /--More-- \(q\) quit \(u\) pageup \(\/\) search \(n\) repeat|-- ?MORE ?--, next page: Space, next line: Enter, quit: Control-C|---\(more(?: \d+%)?\)---|-- ?MORE ?--/gi;

function splitPagerPrompts(text: string): string {
  return text.replace(PAGER_PROMPT, '$&\n');
}

/** Longer lines are hidden whole. Some rules slow down with the square of a
 *  line's length (200 KB of "tokentoken…" takes seconds), and device output
 *  never has lines this long. */
export const MAX_LINE_CHARS = 8192;

function hideLongLines(text: string): ScrubTextResult {
  if (text.length <= MAX_LINE_CHARS) return { text, hidden: 0, kinds: [] };
  let hidden = 0;
  const lines = text.split('\n').map((line) => {
    if (line.length <= MAX_LINE_CHARS) return line;
    hidden++;
    return LINE_MARKER;
  });
  return { text: hidden ? lines.join('\n') : text, hidden, kinds: [] };
}

/** How many brace levels deep the text starts: the lowest running depth it
 *  reaches, as a positive number (0 when it never closes more than it opens). */
function startDepth(text: string): number {
  let depth = 0;
  let lowest = 0;
  for (const char of text) {
    if (char === '{') depth++;
    else if (char === '}') lowest = Math.min(lowest, --depth);
  }
  return -lowest;
}

/**
 * Lines put in front of text that may start in the middle of a block (a
 * paged or trimmed capture), so a block whose opening line was cut off still
 * counts: a RADIUS/TACACS "key X" line, a Junos "community NAME" inside
 * snmp { }, or the body of a private key whose BEGIN line is gone.
 */
function cutHeadOpeners(text: string): string[] {
  const openers = [`snmp ${'{'.repeat(Math.max(1, startDepth(text)))}`, 'aaa authentication-server radius cut-off'];
  const end = text.search(PEM_END);
  const begin = text.search(PEM_BEGIN);
  if (end >= 0 && (begin < 0 || begin > end)) openers.push('-----BEGIN PRIVATE KEY-----');
  return openers;
}

function deviceRules(text: string, cutHead: boolean): ScrubTextResult {
  if (!cutHead) return scrubText(text);
  const openers = cutHeadOpeners(text);
  const result = scrubText(`${openers.join('\n')}\n${text}`);
  if (!result.hidden) return { text, hidden: 0, kinds: [] };
  return { ...result, text: result.text.split('\n').slice(openers.length).join('\n') };
}

export interface ScrubForAiOptions {
  /** The text may start inside a block whose first line was cut off. */
  cutHead?: boolean;
}

/**
 * Every text rule, in order: lines too long to check are hidden whole, device
 * config lines (with block state), the
 * password in user:password@ addresses, secret-named KEY=VALUE pairs, and the
 * ways people write secrets in notes ("pw: X", "root / X").
 */
export function scrubForAi(text: string, options: ScrubForAiOptions = {}): ScrubTextResult {
  const kinds = new Set<SecretKind>();
  let hidden = 0;
  let out = splitPagerPrompts(text);
  const passes: Array<(value: string) => ScrubTextResult> = [
    hideLongLines,
    (value) => deviceRules(value, options.cutHead === true),
    scrubUrlPasswords,
    (value) => scrubAssignments(value, false),
    scrubProseSecrets,
  ];
  for (const pass of passes) {
    const result = pass(out);
    out = result.text;
    hidden += result.hidden;
    for (const kind of result.kinds) kinds.add(kind);
  }
  return { text: hidden ? out : text, hidden, kinds: KIND_ORDER.filter((kind) => kinds.has(kind)) };
}

// public and private are hidden like any other community, but an audit has to
// know a well-known default is in use. The hint says so without saying which.
const DEFAULT_COMMUNITY =
  /(?:\bsnmp-server\s+community|\bsnmp\s+community|^\s*community)\s+["']?(?:public|private)["']?(?=[\s;{]|$)/im;
export const DEFAULT_COMMUNITY_HINT =
  '[GreenCLI: an SNMP community in this output is a well-known default (public or private).]';

/** The hint line when the raw text sets SNMP community public or private. */
export function defaultCommunityHint(text: string): string | undefined {
  return DEFAULT_COMMUNITY.test(text) ? DEFAULT_COMMUNITY_HINT : undefined;
}

/** A REST or MCP result: secret-named keys (password, passkey, snmp_communities
 *  …) are hidden, every string runs through scrubForAi, JSON inside text is
 *  opened and written back as JSON, and paging fields (_pagination, cursors)
 *  stay as they are. */
export function scrubJsonForAi<T>(value: T): ScrubValueResult<T> {
  return scrubValue(value, (text) => scrubForAi(text));
}
