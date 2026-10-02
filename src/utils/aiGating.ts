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
 *  kernel trace pipe. Quotes and backslashes are dropped first ("/d\ev/zero"). A path with a ".."
 *  part counts too: /proc/self/../self/fd/0 is the keyboard, and a ".." after a link (/proc/self/cwd)
 *  can't be worked out from the text. */
function devicePath(word: string): boolean {
  const path = word.replace(/["'\\]/g, '').replace(/\/{2,}/g, '/').replace(/\/\.(?=\/)/g, '');
  if (path.includes('/') && path.split('/').includes('..')) return true;
  if (path === '/dev/null') return false;
  return /(?:^|\/)dev\//.test(path) || /(?:^|\/)proc\/[^/]+\/fd(?:\/|$)/.test(path)
    || /(?:^|\/)proc\/kmsg$/.test(path) || /(?:^|\/)tracing\//.test(path);
}

/** A file cat, head or tail must not read: a devicePath, or a name the shell would change first
 *  ($VAR, or a pattern in a folder name: /d?v/zero), so the check can't see the real file. */
function blockingFile(word: string): boolean {
  return devicePath(word) || word.includes('$') || /[*?[{].*\//.test(word);
}

/** cat, head or tail with a file to read. With none (or only "-", or tail with only +N) they wait on the keyboard, and
 *  the AI's next line is typed into them. A file that never ends or reads the keyboard
 *  (blockingFile) is refused too. */
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
  return files.some((f) => f !== '-') && !files.some((f) => f === '-' || blockingFile(f));
}

/** The command word without a Windows .exe (ping.exe, PING.EXE). */
function verbOf(word: string | undefined): string {
  return (word ?? '').toLowerCase().replace(/\.exe$/, '');
}

/** Plain reads that end: date without a time to set, ping with a small count, cat/head/tail with
 *  a file, tail without follow (also as a pipe stage), and sh (Aruba and Cisco show) not running a
 *  shell (sh -c ..., sh script.sh). */
function auditorWordsOk(line: string): boolean {
  const stages = line.split('|').map((stage) => stage.trim().split(/\s+/).filter(Boolean));
  const first = stages[0] ?? [];
  const verb = verbOf(first[0] === 'do' ? first[1] : first[0]);
  const args = first.slice(first[0] === 'do' ? 2 : 1);
  if (verb === 'date' && !args.every((w) => DATE_SHOW_ARG.test(w))) return false;
  if (verb === 'ping' && !pingEnds(args)) return false;
  if (['cat', 'head', 'tail'].includes(verb) && !readsAFile(verb, args)) return false;
  if (verb === 'sh' && /^-|[/.]/.test(args[0] ?? '')) return false;
  // A pipe stage that names a file reads it instead of the pipe (show x | tail /dev/zero).
  if (stages.slice(1).some((words) => words.slice(1).some(devicePath))) return false;
  return stages.every((words) => verbOf(words[0]) !== 'tail' || !tailFollows(words.slice(1)));
}

/**
 * The stricter check for the Read-only Auditor: every line must be a plain read. It starts with a
 * read word (show, display, get, ping, ...; not less, more or monitor), has no write word, no `;`,
 * `&`, `<`, `>`, backtick or `$(`, each `|` stage is in AUDITOR_PIPES, `date` sets no time,
 * `ping` has a count of 1 to 100 and no long interval or wait, `cat`/`head`/`tail` name a file
 * that ends, `tail` doesn't follow and `sh` doesn't run a shell. Anything else is refused, with no
 * dialog.
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
