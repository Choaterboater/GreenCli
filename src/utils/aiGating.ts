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
/**
 * The Auditor's own read verbs: the first word of a line (after an optional Aruba `do`), matched
 * exactly, in any case. AI_READ_ONLY_CMD without less, more and monitor (they open a pager or a live
 * view, and the AI's next line would be typed into it as keys) and without `?`.
 */
const AUDITOR_VERBS: ReadonlySet<string> = new Set([
  // No `sh` short form: on a Linux server `sh` (or `sh WORD`) starts a shell or runs a script.
  'show', 'disp', 'display', 'get', 'ping', 'traceroute', 'tracert', 'dir', 'cat', 'tail', 'head',
  'echo', 'whoami', 'who', 'uptime', 'date',
]);
/** Windows commands the Auditor also takes with .exe (PING.EXE). */
const AUDITOR_EXE_VERBS: ReadonlySet<string> = new Set(['ping', 'tracert', 'whoami']);
/** date only shows the time: no arguments, or only a +FORMAT, -u/--utc, -R or -I. `date -s` sets the clock. */
const DATE_SHOW_ARG = /^(?:\+\S*|-u|--utc|--universal|-R|--rfc-email|-I\w*|--iso-8601(?:=\w+)?)$/;

/** `tail -f` (and -F, --follow, -fn 20) never ends, so the AI's next line is typed into it. So does
 *  the old `tail +1f FILE` (GNU and BSD tail read +Nf and +f as start-at-line N and follow): any word
 *  starting with + that has an f or F in it counts as follow. */
function tailFollows(words: string[]): boolean {
  return words.some((w) => /^--(?:follow|retry)/i.test(w) || /^-[A-Za-z0-9]*[fF]/.test(w) || /^\+.*[fF]/.test(w));
}

/** Words that set how many pings to send: Linux and macOS -c N, Windows -n N, Junos count N,
 *  Aruba repetitions N, Cisco repeat N. */
const PING_COUNT_WORDS: ReadonlySet<string> = new Set(['-c', '-n', 'count', 'repetitions', 'repeat']);
/** At most this many pings, so the ping ends in a few minutes at most. */
const PING_MAX_COUNT = 100;
/** Words that set the time between pings: -i N (Linux, macOS), Junos interval N. */
const PING_INTERVAL_WORDS: ReadonlySet<string> = new Set(['-i', 'interval']);
const PING_MAX_INTERVAL = 5;
/** Words that set how long to wait for a reply, or for the whole ping: Junos wait, Aruba and Cisco
 *  timeout (seconds), Linux -w/-W (seconds), macOS -W (ms) and -t (seconds), Windows -w (ms). */
const PING_WAIT_WORDS: ReadonlySet<string> = new Set(['wait', 'timeout', 'deadline']);
const PING_WAIT_FLAGS: ReadonlySet<string> = new Set(['-w', '-t']);
const PING_MAX_WAIT = 60;
/** -w and -W in milliseconds (Windows, macOS -W): allowed up to 10 seconds. */
const PING_MAX_WAIT_MS = 10000;
const NUMBER = /^\d+(?:\.\d+)?$/;

/** A ping option word in one spelling: Windows /n and /t read as -n and -t. Case matters for
 *  -W and -w only through PING_WAIT_FLAGS, which takes both. */
function pingWord(word: string): string {
  return /^\/[A-Za-z]$/.test(word) ? `-${word[1]}` : word;
}

/** ping with a count from 1 to 100, no interval over 5 seconds and no long wait. Without a count,
 *  Linux and Junos ping run until Ctrl-C (Windows -t too), so the AI's next line is typed into it. */
function pingEnds(raw: string[]): boolean {
  const words = raw.map(pingWord);
  let counted = false;
  for (let i = 0; i < words.length; i++) {
    const w = words[i]!;
    const lower = w.toLowerCase();
    const next = words[i + 1] ?? '';
    const attached = /^-c(\d+)$/.exec(w);
    if (attached || PING_COUNT_WORDS.has(lower)) {
      const value = attached ? attached[1]! : next;
      if (!/^\d+$/.test(value) || Number(value) < 1 || Number(value) > PING_MAX_COUNT) return false;
      counted = true;
    } else if (PING_INTERVAL_WORDS.has(lower)) {
      if (!NUMBER.test(next) || Number(next) > PING_MAX_INTERVAL) return false;
    } else if (PING_WAIT_WORDS.has(lower)) {
      if (!NUMBER.test(next) || Number(next) > PING_MAX_WAIT) return false;
    } else if (PING_WAIT_FLAGS.has(lower)) {
      // Windows -t (no value) pings until Ctrl-C; macOS -t N and Linux -w N end after N seconds.
      if (!NUMBER.test(next) || Number(next) > PING_MAX_WAIT_MS) return false;
    }
  }
  return counted;
}

/** head and tail options that take a value as the next word: -n, -c, BSD tail -b, GNU tail -s,
 *  and these long options (GNU takes any unique start of one: --lin 5). */
const VALUE_LETTERS: Record<string, string> = { head: 'nc', tail: 'ncbs' };
const VALUE_LONG = ['bytes', 'lines', 'max-unchanged-stats', 'pid', 'sleep-interval'];
const FLAG_LONG = ['quiet', 'silent', 'verbose', 'zero-terminated', 'help', 'version'];

/** The option takes the next word as its value. An unknown long option is taken to have one, so
 *  the check never counts a value as a file. */
function takesValue(verb: string, option: string): boolean {
  if (verb === 'cat') return false;
  if (option.startsWith('--')) {
    if (option.includes('=')) return false;
    const name = option.slice(2).toLowerCase();
    return VALUE_LONG.some((long) => long.startsWith(name)) || !FLAG_LONG.some((long) => long.startsWith(name));
  }
  return /^-[A-Za-z]+$/.test(option) && (VALUE_LETTERS[verb] ?? '').includes(option[option.length - 1]!);
}

/** A path to a file that never ends or waits on the keyboard: /dev/stdin, /dev/tty, /dev/fd/0,
 *  /dev/zero, /dev/random, any other /dev file but /dev/null, /proc/<pid>/fd/*, /proc/kmsg and the
 *  kernel trace pipe. A path with a ".." part counts too: /proc/self/../self/fd/0 is the keyboard,
 *  and a ".." after a link (/proc/self/cwd) can't be worked out from the text. */
function devicePath(word: string): boolean {
  const path = word.replace(/\/{2,}/g, '/').replace(/\/\.(?=\/)/g, '');
  if (path.includes('/') && path.split('/').includes('..')) return true;
  if (path === '/dev/null') return false;
  return /(?:^|\/)dev\//.test(path) || /(?:^|\/)proc\/[^/]+\/fd(?:\/|$)/.test(path)
    || /(?:^|\/)proc\/kmsg$/.test(path) || /(?:^|\/)tracing\//.test(path);
}

/** cat, head or tail with a file to read. With none (or only "-", or tail with only +N) they wait on
 *  the keyboard, and the AI's next line is typed into them. An empty name ("") is not a file. A file
 *  that never ends or reads the keyboard (devicePath) is refused too. */
function readsAFile(verb: string, words: string[]): boolean {
  const files: string[] = [];
  for (let i = 0; i < words.length; i++) {
    const w = words[i]!;
    if (w === '--') {
      files.push(...words.slice(i + 1));
      break;
    }
    if (w.startsWith('-') && w !== '-') {
      if (takesValue(verb, w)) i++;
      continue;
    }
    // GNU tail reads the old `tail +N` as "start at line N", not as a file: `tail +2` reads the
    // keyboard.
    if (verb === 'tail' && w.startsWith('+')) continue;
    files.push(w);
  }
  return files.some((f) => f !== '-' && f !== '') && !files.some((f) => f === '-' || devicePath(f));
}

/** The only characters the Auditor takes outside quotes: letters, digits, space, tab and . _ / : @ ,
 *  = + - |. Everything a shell or a device CLI treats specially ($ ` \ ; & > < ( ) { } [ ] # * ? ! ~
 *  ^ % and quotes glued to a word) is left out, so the text the check reads is the text that runs. */
const AUDITOR_CHAR = /^[A-Za-z0-9 \t._/:@,=+|-]$/;
/** What a quoted word may hold: the same characters, and no quote, $, backtick or backslash. */
const AUDITOR_QUOTED = /^[A-Za-z0-9 \t._/:@,=+|-]*$/;
const WORD_GAP = /^[ \t|]$/;

/**
 * One line split into pipe stages and words, or null when the line has anything the Auditor does
 * not take. Words are split on spaces and tabs, stages on | (outside quotes). A '...' or "..."
 * counts only as a whole word (after the start, a space or a |, and before the end, a space or a |)
 * holding only AUDITOR_QUOTED characters; the word is its text without the quotes. sh''utdown,
 * tail"" -f and -""f are refused, so no word means anything else to the shell.
 */
export function auditorStages(line: string): string[][] | null {
  const stages: string[][] = [[]];
  let word: string | null = null;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i]!;
    const stage = stages[stages.length - 1]!;
    if (ch === "'" || ch === '"') {
      const close = line.indexOf(ch, i + 1);
      if (word !== null || close < 0) return null;
      const inner = line.slice(i + 1, close);
      const after = line[close + 1];
      if (!AUDITOR_QUOTED.test(inner) || (after !== undefined && !WORD_GAP.test(after))) return null;
      stage.push(inner);
      i = close;
    } else if (!AUDITOR_CHAR.test(ch)) {
      return null;
    } else if (WORD_GAP.test(ch)) {
      if (word !== null) stage.push(word);
      word = null;
      if (ch === '|') stages.push([]);
    } else {
      word = (word ?? '') + ch;
    }
  }
  if (word !== null) stages[stages.length - 1]!.push(word);
  return stages;
}

/** The first stage's verb, when it is one of the Auditor's read verbs (ping.exe reads as ping). */
function auditorVerb(word: string | undefined): string | undefined {
  const lower = (word ?? '').toLowerCase();
  if (AUDITOR_VERBS.has(lower)) return lower;
  const base = lower.replace(/\.exe$/, '');
  return lower.endsWith('.exe') && AUDITOR_EXE_VERBS.has(base) ? base : undefined;
}

/** One line the Auditor may run: AUDITOR_CHAR text (auditorStages), a read verb first (after an
 *  optional `do`), an AUDITOR_PIPES filter first in every later stage, no pipe that writes a file,
 *  and the word checks: date sets no time, ping ends, cat/head/tail read a file that ends, tail
 *  doesn't follow, and a later stage names no device file. */
function auditorLineOk(line: string): boolean {
  // Only the write-to-file pipes (| save, | append, | tee …). The other aiIsWriteCommand words
  // (commit, boot, rollback …) can't run here: the line starts with a read verb and holds no shell
  // syntax, so as arguments they are just text (show system commit, show boot-history).
  if (AI_WRITE_PIPE.test(line)) return false;
  const stages = auditorStages(line);
  if (!stages) return false;
  const [first = [], ...rest] = stages;
  const words = first[0]?.toLowerCase() === 'do' ? first.slice(1) : first;
  const verb = auditorVerb(words[0]);
  if (verb === undefined) return false;
  if (!rest.every((stage) => AUDITOR_PIPES.has((stage[0] ?? '').toLowerCase()))) return false;
  const args = words.slice(1);
  if (verb === 'date' && !args.every((w) => DATE_SHOW_ARG.test(w))) return false;
  if (verb === 'ping' && !pingEnds(args)) return false;
  if ((verb === 'cat' || verb === 'head' || verb === 'tail') && !readsAFile(verb, args)) return false;
  if (verb === 'tail' && tailFollows(args)) return false;
  // A pipe stage that names a file reads it instead of the pipe (show x | tail /dev/zero).
  return rest.every((stage) => !stage.slice(1).some(devicePath) && (stage[0]?.toLowerCase() !== 'tail' || !tailFollows(stage.slice(1))));
}

/**
 * The stricter check for the Read-only Auditor: every line must be a plain read (auditorLineOk).
 * The raw text is held to a short list of characters, so the words the check reads are the words
 * that run: no shell or device CLI syntax is interpreted, it is refused. Anything else is refused,
 * with no dialog.
 */
export function auditorAllowsCommand(cmd: string): boolean {
  if (CONTROL_CHARS.test(cmd)) return false;
  return cmd.split(LINE_BREAK).every((line) => {
    // Only spaces and tabs are trimmed: any other character at either end is the device's to read.
    const c = line.replace(/^[ \t]+|[ \t]+$/g, '');
    return !c || auditorLineOk(c);
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
