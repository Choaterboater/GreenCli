// Config Editor send safety: which lines are dangerous, what a device error
// looks like, and a send loop that stops at the first error instead of
// pushing the rest of a config blind.

import { listen } from '@tauri-apps/api/event';
import { stripAnsi } from './terminal';
import type { ConnectionConfig } from '../types';

// ─── Dangerous-line classifier ───

// Whole-token match: `-` counts as part of a word, so `shutdown-window` or
// `reload-timer` in a name/description don't match. (No lookbehind — older
// macOS WebKit rejects it and the whole editor would fail to load.)
const T = '(?:^|[^\\w-])';
const E = '(?![\\w-])';
// An optional `do ` prefix (exec command run from config mode).
const DO = '^\\s*(?:do\\s+)?';

const DANGEROUS_PATTERNS: RegExp[] = [
  // Wipe / factory-reset / reboot.
  new RegExp(`${DO}erase${E}`, 'i'),
  new RegExp(`${DO}write\\s+erase${E}`, 'i'),
  new RegExp(`${T}zeroize${E}`, 'i'),
  // `reload cancel` just cancels a scheduled reload.
  new RegExp(`${DO}reload${E}(?!\\s+cancel)`, 'i'),
  new RegExp(`${DO}(?:request\\s+system\\s+)?(?:reboot|halt|power-off)${E}`, 'i'),
  // AOS-CX reboots with `boot system`.
  new RegExp(`${DO}boot\\s+system${E}`, 'i'),
  // Junos: a bare `delete` wipes the whole candidate config; `load override`
  // / `load factory-default` replace it.
  /^\s*delete\s*$/i,
  /^\s*delete\s+configuration\b/i,
  /^\s*load\s+(?:override|factory-default)\b/i,
  // Deleting the whole system hierarchy, or the parts that carry management
  // access (SSH, logins, root password). Other `delete system …` is routine.
  /^\s*delete\s+system(?:\s*$|\s+(?:services|login|root-authentication)\b)/i,
  // Taking something down. `shutdown` counts only when the line isn't a
  // `no …` negation: `no shutdown` (and `no ip ospf shutdown`) bring things
  // UP, and flagging them buried the real warnings.
  new RegExp(`^(?!\\s*no\\s).*${T}shutdown${E}`, 'i'),
  // Junos equivalents of shutdown.
  /^\s*set\s+interfaces\s+\S+(?:\s+unit\s+\S+)?\s+disable\s*$/i,
  /^\s*deactivate\s+interfaces\b/i,
  // Removing interfaces, VLANs, or a whole routing process.
  /^\s*no\s+interface\b/i,
  /^\s*no\s+vlan\s+\d/i,
  /^\s*no\s+router\s+\S+/i,
  // Overwriting a config from elsewhere. `copy running-config startup-config`
  // is the normal SAVE step, so it is NOT flagged — same as Junos `commit`,
  // the required apply step: flagging those trained people to ignore the
  // warning entirely.
  /^\s*copy\s+(?!run(?:ning-config)?\b)(?:\S+\s+){1,3}(?:start(?:up-config)?|run(?:ning-config)?)\b/i,
];

// Free text (descriptions, names, banners) can say anything — `description
// shutdown after cutover` is not a shutdown. Blank it out before matching.
const FREE_TEXT = /(^|[^\w-])(description|name|alias|banner(?:\s+\S+)?)(?![\w-])\s+.*$/i;

/** True when a config line would erase, reboot, shut down, or remove something. */
export function isDangerousLine(line: string): boolean {
  const cmd = line.replace(/"[^"]*"|'[^']*'/g, '""').replace(FREE_TEXT, '$1$2');
  return DANGEROUS_PATTERNS.some((p) => p.test(cmd));
}

// ─── Lines to send ───

export interface SendLine {
  text: string;
  /** 1-based line number in the editor, for "go to line". */
  lineNumber: number;
}

/** The editor lines that actually go to the device (comments dropped). */
export function prepareSendLines(content: string): SendLine[] {
  // Blank out /* … */ comments across the WHOLE buffer (multi-line Junos
  // annotations included) but keep their newlines, so line numbers still
  // match the editor.
  const text = content.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ''));
  const out: SendLine[] = [];
  text.split('\n').forEach((raw, i) => {
    const l = raw.trim();
    // Drop pure comment lines for every supported vendor ('!' '#'), and any
    // stray delimiter left by an UNTERMINATED /* (the regex above needs a */).
    if (!l || l.startsWith('!') || l.startsWith('#') || l.startsWith('/*') || l.startsWith('*/')) return;
    out.push({ text: l, lineNumber: i + 1 });
  });
  return out;
}

// ─── Device responses ───

const DEVICE_ERROR_PATTERNS: RegExp[] = [
  /invalid (?:input|command)/i, // AOS-CX / AOS-S / AOS-8
  /^\s*% /m, // AOS-S / CX / AOS-8 error lines start with "% "
  /syntax error/i, // Junos
  /^\s*error:/im, // Junos (commit/check-out failures)
  /unknown command/i, // Junos / AOS-8
  /incomplete (?:command|input)/i,
  /ambiguous (?:command|input)/i,
];

/** True when a device response contains an error message. */
export function hasDeviceError(response: string): boolean {
  return DEVICE_ERROR_PATTERNS.some((p) => p.test(response));
}

// Prompts end in # or > (network CLIs), $ or % (shells).
const PROMPT_END = /[#>$%]\s*$/;
// "(y/n)", "[yes,no]", "Continue?" — the device is waiting for an answer.
const QUESTION = /\(y\/n\)|\[y\/n\]|\(yes\/no\)|\[yes,\s*no\]|continue\s*\?\s*$|\bconfirm\b[^\n]*$/i;

/** Text after the last newline: the prompt (or question) the device is showing. */
function tailLine(text: string): string {
  return text.slice(text.lastIndexOf('\n') + 1);
}

export function looksLikePrompt(text: string): boolean {
  const tail = tailLine(text).trimEnd();
  return text.includes('\n') && tail.length > 0 && tail.length <= 200 && PROMPT_END.test(tail);
}

export function looksLikeQuestion(text: string): boolean {
  return QUESTION.test(tailLine(text));
}

/** The response without its trailing prompt line (a bare "% " shell prompt
 *  must not read as an AOS "% " error). */
function withoutPrompt(text: string): string {
  return looksLikePrompt(text) ? text.slice(0, text.lastIndexOf('\n')) : text;
}

// `configure` / `configure terminal` / `conf t` fail harmlessly when the
// session is already in config mode — don't stop the whole send for that.
const ENTER_CONFIG = /^conf(?:igure)?(?:\s+t(?:erminal)?)?(?:\s+(?:private|exclusive))?$/i;

// Lines that can legitimately take a while (Junos commit, saving config).
const SLOW_LINE = /^(?:commit|write|wr|copy|save)\b/i;

// ─── Send loop ───

export interface SendIO {
  send: (data: string) => Promise<unknown>;
  /** Everything the session has printed since sending started (raw). */
  output: () => string;
  sleep: (ms: number) => Promise<void>;
  cancelled: () => boolean;
  now: () => number;
  onProgress?: (sent: number) => void;
}

export type SendResult =
  | { kind: 'done'; sent: number }
  | { kind: 'cancelled'; sent: number }
  /** `failedIndex` is into the lines array. `sent` can be past it when a
   *  slow device only answered after the next line had gone out. */
  | { kind: 'device-error'; sent: number; failedIndex: number; deviceText: string }
  | { kind: 'question'; sent: number; failedIndex: number; deviceText: string }
  | { kind: 'send-failed'; sent: number; error: unknown };

export const SEND_TIMING = {
  poll: 25,
  /** A device that doesn't echo and printed nothing — move on. */
  noOutput: 1500,
  /** Output stopped but no recognizable prompt — move on. */
  quiet: 500,
  /** Hard cap per line; commit / write memory get the long one. */
  maxWait: 4000,
  slowMaxWait: 60_000,
  /** Quiet time that ends a multi-line error message (Junos caret + text). */
  errorSettle: 300,
};

// How many earlier lines' output is re-read when matching echoes, so an
// answer that lands late is still pinned on the line that caused it.
const LOOKBACK = 3;

/** The device's response lines, minus the prompt and Junos [edit] context. */
function responseText(response: string): string {
  const lines = response.split('\n').map((l) => l.trimEnd());
  if (looksLikePrompt(response)) lines.pop();
  return lines
    .filter((l) => l.trim() && !/^\[edit\b.*\]$/.test(l.trim()))
    .slice(-8)
    .join('\n')
    .slice(0, 600);
}

interface Segment {
  /** Index of the line whose echo this output follows (-1: none of ours). */
  owner: number;
  text: string;
}

/** Where a sent line's echo is in `text` (searching from `from`), or null. */
export function findEcho(text: string, echo: string, from: number): { at: number; end: number } | null {
  const exact = text.indexOf(echo, from);
  if (exact >= 0) return { at: exact, end: exact + echo.length };
  // A line longer than the terminal is wide can come back wrapped, with a
  // CR / newline / space pushed in at the right margin — match it ignoring
  // whitespace. Short lines match exactly only, to avoid chance hits.
  const needle = echo.replace(/\s+/g, '');
  if (needle.length < 12) return null;
  let hay = '';
  const pos: number[] = [];
  for (let j = from; j < text.length; j++) {
    if (/\s/.test(text[j])) continue;
    hay += text[j];
    pos.push(j);
  }
  const k = hay.indexOf(needle);
  return k < 0 ? null : { at: pos[k], end: pos[k + needle.length - 1] + 1 };
}

/**
 * Split recent output into per-line segments at each line's echo. Output
 * after line k's echo (up to the next echo) is line k's answer — that's what
 * pins a late error on the right line.
 */
function segmentByEcho(
  text: string,
  lines: SendLine[],
  lo: number,
  hi: number
): { segs: Segment[]; found: boolean } {
  const segs: Segment[] = [];
  let pos = 0;
  let owner = -1;
  for (let k = lo; k <= hi; k++) {
    const hit = findEcho(text, lines[k].text, pos);
    if (!hit) continue;
    // Output before the first echo in the window follows the line before it.
    segs.push({ owner: segs.length ? owner : k - 1, text: text.slice(pos, hit.at) });
    owner = k;
    pos = hit.end;
  }
  if (!segs.length) return { segs: [{ owner: lo - 1, text }], found: false };
  segs.push({ owner, text: text.slice(pos) });
  return { segs, found: true };
}

/**
 * Send config lines one at a time, waiting for the device to answer each one,
 * and stop at the first device error or question. Output is read through
 * `io.output()`, so the loop is testable without a session.
 */
export async function runConfigSend(lines: SendLine[], io: SendIO): Promise<SendResult> {
  const marks: number[] = [];
  // Learned from the output: does this device echo what we type?
  let echoes = false;
  for (let i = 0; i < lines.length; i++) {
    if (io.cancelled()) return { kind: 'cancelled', sent: i };
    const line = lines[i].text;
    marks.push(io.output().length);
    try {
      await io.send(line + '\r');
    } catch (error) {
      return { kind: 'send-failed', sent: i, error };
    }
    const sent = i + 1;
    io.onProgress?.(sent);

    // Wait for the device to answer this line before sending the next, so an
    // error stops the send right there.
    const slow = SLOW_LINE.test(line);
    const maxWait = slow ? SEND_TIMING.slowMaxWait : SEND_TIMING.maxWait;
    const lo = Math.max(0, i - LOOKBACK);
    const start = io.now();
    let lastLen = marks[i];
    let lastChange = start;
    for (;;) {
      await io.sleep(SEND_TIMING.poll);
      const raw = io.output();
      const t = io.now();
      if (raw.length !== lastLen) {
        lastLen = raw.length;
        lastChange = t;
      }
      const split = segmentByEcho(stripAnsi(raw.slice(marks[lo])), lines, lo, i);
      echoes ||= split.found;
      // Without echoes nothing can be told apart: everything since this line
      // went out is its answer.
      const segs: Segment[] = echoes
        ? split.segs
        : [{ owner: i, text: stripAnsi(raw.slice(marks[i])) }];
      const last = segs[segs.length - 1];

      let settling = false;
      for (const seg of segs) {
        // Echoes are cut out of the segments, so a description or banner
        // that contains "error:" can't trip this.
        if (seg.owner < 0 || ENTER_CONFIG.test(lines[seg.owner].text)) continue;
        if (!hasDeviceError(withoutPrompt(seg.text))) continue;
        // Still arriving? Let the rest of a multi-line message come in.
        if (seg === last && !looksLikePrompt(seg.text) && t - lastChange < SEND_TIMING.errorSettle && t - start < maxWait) {
          settling = true;
          break;
        }
        return { kind: 'device-error', sent, failedIndex: seg.owner, deviceText: responseText(seg.text) };
      }
      if (settling) continue;

      const mine = last.owner === i ? last.text : null;
      if (mine != null && looksLikePrompt(mine)) break;
      if (mine != null && looksLikeQuestion(mine)) {
        return { kind: 'question', sent, failedIndex: i, deviceText: responseText(mine) };
      }
      if (io.cancelled()) return { kind: 'cancelled', sent };
      // No recognizable prompt: move on once the device goes quiet (or never
      // answered), except for commit / save, which can be silent for a while.
      const waited = t - start;
      if (!slow && !echoes && raw.length === marks[i] && waited >= SEND_TIMING.noOutput) break;
      if (!slow && mine?.trim() && t - lastChange >= SEND_TIMING.quiet) break;
      if (waited >= maxWait) break;
    }
  }
  return { kind: 'done', sent: lines.length };
}

/**
 * Collect a session's output from the moment this is called, straight from
 * the `terminal_data` stream — only the new bytes, rather than re-reading the
 * whole ~150KB backend buffer after every line.
 */
export async function watchSessionOutput(
  sessionId: string
): Promise<{ output: () => string; dispose: () => void }> {
  const decoder = new TextDecoder();
  let text = '';
  const unlisten = await listen<{ sessionId: string; data: number[] }>('terminal_data', (event) => {
    if (event.payload.sessionId !== sessionId) return;
    text += decoder.decode(new Uint8Array(event.payload.data), { stream: true });
  });
  return { output: () => text, dispose: unlisten };
}

// ─── Diff baseline per device ───

export interface Baseline {
  text: string;
  /** Who it came from, for the preview ("core-sw1"). */
  label: string;
  pulledAt: number;
  truncated: boolean;
}

/** Stable identity of the device behind a session: protocol + host/port. */
export function deviceKey(config: ConnectionConfig): string {
  const target = config.host || config.serialPort || config.command || config.name || '';
  return [config.protocol, target.toLowerCase(), config.port ?? ''].join('|');
}

export function summarizeLineDiff(original: string, next: string): string {
  const oldLines = original.split('\n').map((line) => line.trim()).filter(Boolean);
  const newLines = next.split('\n').map((line) => line.trim()).filter(Boolean);
  const oldSet = new Set(oldLines);
  const newSet = new Set(newLines);
  const added = newLines.filter((line) => !oldSet.has(line));
  const removed = oldLines.filter((line) => !newSet.has(line));
  const examples = [
    ...added.slice(0, 3).map((line) => `+ ${line}`),
    ...removed.slice(0, 3).map((line) => `- ${line}`),
  ];
  return `+${added.length} / -${removed.length}${examples.length ? `\n${examples.join('\n')}` : ''}`;
}

const clock = (ms: number) =>
  new Date(ms).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

/**
 * The diff part of the send preview. Only ever compares against a baseline
 * pulled from the device being sent to; a baseline from another device is
 * called out rather than silently used.
 */
export function describeSendBaseline(
  content: string,
  target: string,
  baseline: Baseline | undefined,
  lastPulled: Baseline | undefined
): string {
  if (baseline) {
    return (
      `Diff vs running-config pulled from ${baseline.label} at ${clock(baseline.pulledAt)}` +
      `${baseline.truncated ? ' (that capture may be incomplete)' : ''}: ` +
      summarizeLineDiff(baseline.text, content)
    );
  }
  if (lastPulled) {
    return (
      `No running-config pulled from ${target} yet. The last pull was from ${lastPulled.label}, ` +
      `so it is not compared here — Pull from ${target} to see what will change.`
    );
  }
  return `No running-config pulled from ${target} yet; review the preview before sending.`;
}
