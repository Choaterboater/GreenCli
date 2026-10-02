import type { AiAgent } from '../types';

// ─── Write-confirmation gate for AI-issued device actions ───
//
// The AI tool loop is reachable by prompt injection: device output (LLDP
// neighbor names, banners), MCP-server responses, and REST payloads are fed
// back to the model as tool results, so injected text could drive a destructive
// command with no user interaction. The manual paths already confirm writes
// (ApiExplorer confirms non-GET, Terminal confirms multi-line pastes); this is
// the code-level equivalent for the AI path. Obvious reads pass with no dialog
// to keep the diagnostic path fast; everything else is confirmed (fail-safe).
export const AI_READ_ONLY_CMD =
  /^\s*(do\s+)?(sh(ow)?|disp(lay)?|get|ping|traceroute|tracert|monitor|dir|more|less|cat|tail|head|echo|whoami|who|uptime|date|\?)\b/i;
export const AI_CONFIG_ENTER = /^\s*conf(ig(ure)?)?\b/i;
export const AI_DESTRUCTIVE_CMD =
  /\b(write|erase|delete|clear|reload|reboot|boot|commit|rollback|copy|format|factory-reset|factory-default|zeroize|request\s+system|install|upgrade)\b/i;
export const AI_DANGER_CMD = /\b(erase|delete|reload|reboot|format|factory|write|zeroize|rollback)\b/i;
// A pipe stage or shell redirect that writes a file: Junos `| save`, `| append` and `| tee` (and
// their short forms: Junos takes `| s` for save and `| a` for append), `| redirect`, and `>`.
// `show log messages | save /var/log/messages` looks like a read but overwrites a file.
export const AI_WRITE_PIPE = /\|\s*(s|sa|sav|save|a|ap|app|appe|appen|append|te|tee|redirect)(\s|$)|>/i;

// Every line break a device treats as Enter. A bare `\r` counts: the command
// goes out with `\r` appended (utils/terminal.ts), so "show version\rconf t"
// runs two commands, and splitting on `\r?\n` alone judged it as one read.
export const LINE_BREAK = /\r\n|\r|\n/;
// Control characters a device acts on mid-line: backspace and Ctrl-U erase
// what the check saw ("show\b\b\b\bconf t"), Ctrl-Z / Ctrl-C leave or abort a
// mode, Tab completes a word, ESC starts a key sequence. Only \r and \n are
// left out, as line breaks. Nothing the AI types needs any of these.
export const CONTROL_CHARS = /[\x00-\x09\x0b\x0c\x0e-\x1f\x7f-\x9f]/;

/** One `\n` per line break, so a confirm dialog shows every line the device runs. */
export function normalizeLineBreaks(cmd: string): string {
  return cmd.split(LINE_BREAK).join('\n');
}

/** Heuristic: does this (possibly multi-line) command modify device state? */
export function aiIsWriteCommand(cmd: string): boolean {
  if (CONTROL_CHARS.test(cmd)) return true; // can't be judged line by line: confirm
  return cmd.split(LINE_BREAK).some((line) => {
    const c = line.trim();
    if (!c) return false;
    if (AI_CONFIG_ENTER.test(c) || AI_DESTRUCTIVE_CMD.test(c) || AI_WRITE_PIPE.test(c)) return true;
    if (AI_READ_ONLY_CMD.test(c)) return false;
    return true; // unknown verb (set/no/interface/vlan/…): confirm to be safe
  });
}

// ─── Read-only Auditor ───

/**
 * Pipe stages the Read-only Auditor may use. None of them can write a file. Junos: match, except,
 * count, display, no-more, last, find, trim. Aruba and Cisco style: include, exclude, begin,
 * section and their usual short forms (but not `s`, which Junos reads as save). Linux: grep,
 * egrep, head, tail, wc.
 */
export const AUDITOR_PIPES: ReadonlySet<string> = new Set([
  'match', 'except', 'count', 'display', 'no-more', 'last', 'find', 'trim',
  'include', 'i', 'in', 'inc', 'incl', 'exclude', 'e', 'ex', 'exc', 'excl',
  'begin', 'b', 'be', 'beg', 'section', 'sec',
  'grep', 'egrep', 'head', 'tail', 'wc',
]);
// Shell characters that chain, redirect or substitute commands.
const AUDITOR_SHELL = /[;&`<>]|\$\(/;
/**
 * The Auditor's own read words: AI_READ_ONLY_CMD without less, more and monitor. Those open a
 * pager or a live view, and the AI's next line would be typed into it as keys.
 */
const AUDITOR_READ_CMD =
  /^\s*(do\s+)?(sh(ow)?|disp(lay)?|get|ping|traceroute|tracert|dir|cat|tail|head|echo|whoami|who|uptime|date|\?)\b/i;
/** date only shows the time: no arguments, or only a +FORMAT, -u/--utc, -R or -I. `date -s` sets the clock. */
const DATE_SHOW_ARG = /^(?:\+\S*|-u|--utc|--universal|-R|--rfc-email|-I\w*|--iso-8601(?:=\w+)?)$/;

/** `tail -f` (and -F, --follow, -fn 20) never ends, so the AI's next line is typed into it. */
function tailFollows(words: string[]): boolean {
  return words.some((w) => /^--(?:follow|retry)/i.test(w) || /^-[A-Za-z0-9]*[fF]/.test(w));
}

/** Plain reads only: date without a time to set, tail without follow (also as a pipe stage). */
function auditorWordsOk(line: string): boolean {
  const stages = line.split('|').map((stage) => stage.trim().split(/\s+/).filter(Boolean));
  const first = stages[0] ?? [];
  const verb = (first[0] === 'do' ? first[1] : first[0])?.toLowerCase();
  const args = first.slice(first[0] === 'do' ? 2 : 1);
  if (verb === 'date' && !args.every((w) => DATE_SHOW_ARG.test(w))) return false;
  return stages.every((words) => (words[0] ?? '').toLowerCase() !== 'tail' || !tailFollows(words.slice(1)));
}

/**
 * The stricter check for the Read-only Auditor: every line must be a plain read. It starts with a
 * read word (show, display, get, ping, ...; not less, more or monitor), has no write word, no `;`,
 * `&`, `<`, `>`, backtick or `$(`, each `|` stage is in AUDITOR_PIPES, `date` sets no time and
 * `tail` doesn't follow. Anything else is refused, with no dialog.
 */
export function auditorAllowsCommand(cmd: string): boolean {
  if (CONTROL_CHARS.test(cmd)) return false;
  return cmd.split(LINE_BREAK).every((line) => {
    const c = line.trim();
    if (!c) return true;
    if (aiIsWriteCommand(c) || !AUDITOR_READ_CMD.test(c) || AUDITOR_SHELL.test(c) || !auditorWordsOk(c)) return false;
    return c
      .split('|')
      .slice(1)
      .every((stage) => AUDITOR_PIPES.has((stage.trim().split(/\s+/)[0] ?? '').toLowerCase()));
  });
}

/** The refusal the model reads when the Read-only Auditor blocks a tool call. */
export const AUDITOR_REFUSAL =
  'Not run: the Read-only Auditor agent is attached, so only tools that read can run. Give the user the exact commands to run instead.';

/**
 * Whether the agent attached to the session is read-only: GreenCLI then refuses every AI tool
 * call that could change something, before any dialog. Agents saved before 1.9 have no
 * `readOnly` field, so the built-in Auditor is also known by its id and by its name (an edited
 * copy, or one re-created by hand). Matching more can only add restrictions.
 */
export function isReadOnlyAgent(agent: Pick<AiAgent, 'id' | 'name' | 'readOnly'> | undefined): boolean {
  if (!agent) return false;
  return (
    agent.readOnly === true ||
    agent.id === 'agent-auditor' ||
    (agent.name ?? '').trim().toLowerCase() === 'read-only auditor'
  );
}
