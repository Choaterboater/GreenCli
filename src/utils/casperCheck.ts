// "Mark mistakes with Casper" in the Config Editor: Casper reads the lines
// (secrets already hidden) and answers with one ```json block of line-numbered
// findings, which the editor shows as squiggles and Problems rows marked
// "Casper". Pure, so it is unit-tested.
//
// Casper's reply is only ever read as data: the last ```json block becomes a
// list of messages on lines that exist; every other word is ignored, and
// nothing in it is run, sent or followed.

import { buildCliPrompt } from './cliPrompt';
import { languageLabel } from './askAi';
import type { ConfigProblem, ProblemSeverity } from './configProblems';
import type { LineSpan } from './sendSelection';

/** Casper reads only the prompt: say what this run is, and what not to try. */
export const CASPER_CHECK_PREFACE =
  "You are checking config lines for a network engineer in GreenCLI's Config Editor. Don't try to connect to their devices or to local ports on this computer, and don't create or change files: read the lines and answer.";

/**
 * Bigger prompts go unsent. The backend keeps at most 64 KiB of a prompt by
 * cutting out its middle, which would make the line numbers lie.
 */
export const CASPER_PROMPT_LIMIT = 60 * 1024;

/** At most this many findings are shown. */
export const MAX_CASPER_PROBLEMS = 50;
const MAX_MESSAGE = 200;

export interface CasperCheckInput {
  /** The lines, secrets already hidden (same line count as the editor's). */
  text: string;
  /** Editor line number of the first line. */
  firstLine: number;
  language: string;
  languageName?: string;
  tabName: string;
  hidden: number;
  /** What GreenCLI already marks on these lines. */
  known: Array<{ lineNumber: number; message: string }>;
}

/** The whole prompt for Casper (preface, "No device connected.", the question). */
export function buildCasperCheckPrompt(input: CasperCheckInput): string {
  const vendor = languageLabel(input.language, input.languageName);
  const lines = input.text.replace(/\n+$/, '').split('\n');
  const last = input.firstLine + lines.length - 1;
  const where = lines.length === 1 ? `line ${input.firstLine}` : `lines ${input.firstLine}–${last}`;
  const numbered = lines.map((line, i) => `${input.firstLine + i}| ${line}`).join('\n');
  const fence = input.text.includes('```') ? '~~~' : '```';
  const parts = [
    `Check these ${vendor} lines for mistakes, risky commands and anything missing.`,
    `From the Config Editor: ${where} of "${input.tabName}" (${vendor}). Each line starts with its line number and "| ".` +
      (input.hidden ? ` ${input.hidden} ${input.hidden === 1 ? 'secret is' : 'secrets are'} hidden as <secret hidden>; that is not a mistake.` : ''),
    `${fence}\n${numbered}\n${fence}`,
  ];
  if (input.known.length) {
    parts.push(
      "Already marked by GreenCLI (don't repeat these):\n" +
        input.known
          .slice(0, 20)
          .map((p) => `- line ${p.lineNumber}: ${p.message}`)
          .join('\n')
    );
  }
  parts.push(
    'Reply with exactly one ```json code block and nothing in it but this shape:\n' +
      '```json\n{"problems":[{"line":12,"severity":"error","message":"One short sentence."}]}\n```\n' +
      `"line" is the line number shown above (${input.firstLine}–${last}). "severity" is "error", "warning" or "tip". ` +
      'Give an empty list if you find nothing.'
  );
  return buildCliPrompt('No device connected.', parts.join('\n\n'), { preface: CASPER_CHECK_PREFACE });
}

/** The prompt is over the limit, counted in UTF-8 bytes as the backend does. */
export function promptTooBig(prompt: string): boolean {
  return new TextEncoder().encode(prompt).length > CASPER_PROMPT_LIMIT;
}

/**
 * The `ai_cli` arguments: Casper in a fresh folder GreenCLI deletes (never
 * the user's project), with the user's own command and Casper's turn limit.
 */
export function casperCheckArgs(o: { command?: string; prompt: string; runId: string; logFolder?: string | null }) {
  return {
    command: o.command?.trim() || 'casper',
    prompt: o.prompt,
    runId: o.runId,
    workFolder: null,
    asCasper: true,
    logFolder: o.logFolder || null,
  };
}

/** A Casper finding, with the text its line had when Casper was asked. */
export interface CasperProblem extends ConfigProblem {
  text: string;
}

export type CasperResult =
  | { ok: true; problems: CasperProblem[]; usage: string | null; turnLimit: boolean }
  | { ok: false; usage: string | null; turnLimit: boolean };

export interface ParseOptions {
  /** The lines that were sent (editor line numbers). */
  span: LineSpan;
  /** The tab's lines when Casper was asked. */
  lines: readonly string[];
  /** What GreenCLI already marks: the same thing on the same line is dropped. */
  known: readonly ConfigProblem[];
}

const NOTES_SEPARATOR = '\n\n---\n';
const JSON_BLOCK = /```json[ \t]*\r?\n([\s\S]*?)\r?\n?```/gi;

/** GreenCLI's own notes under a Casper answer (italic lines after the last rule). */
function notesOf(reply: string): string[] {
  const at = reply.lastIndexOf(NOTES_SEPARATOR);
  if (at < 0) return [];
  return reply
    .slice(at + NOTES_SEPARATOR.length)
    .split(/\n\n+/)
    .map((n) => n.trim())
    .filter((n) => /^\*[^*].*\*$/s.test(n))
    .map((n) => n.slice(1, -1).trim());
}

function plainMessage(raw: string): string {
  const text = raw
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '')
    .replace(/[\x00-\x1f\x7f-\x9f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return text.length > MAX_MESSAGE ? `${text.slice(0, MAX_MESSAGE - 1)}…` : text;
}

const sameText = (a: string, b: string) => {
  const norm = (s: string) => s.toLowerCase().replace(/[\s.!]+$/, '').trim();
  return norm(a) === norm(b);
};

function severityOf(raw: unknown): ProblemSeverity {
  const s = typeof raw === 'string' ? raw.toLowerCase().trim() : '';
  if (s === 'error') return 'error';
  if (s === 'tip' || s === 'info') return 'info';
  return 'warning';
}

/** Casper's findings from its reply. Only the last ```json block counts. */
export function parseCasperProblems(reply: string, o: ParseOptions): CasperResult {
  const notes = notesOf(reply);
  const usage = notes.find((n) => n.startsWith('Casper used ')) ?? null;
  const turnLimit = notes.some((n) => n.startsWith('Casper reached its turn limit'));
  const none = { ok: false as const, usage, turnLimit };

  const blocks = [...reply.matchAll(JSON_BLOCK)];
  if (!blocks.length) return none;
  let data: unknown;
  try {
    data = JSON.parse(blocks[blocks.length - 1][1]);
  } catch {
    return none;
  }
  const list = data && typeof data === 'object' && !Array.isArray(data) ? (data as { problems?: unknown }).problems : undefined;
  if (!Array.isArray(list)) return none;

  const last = Math.min(o.span.end, o.lines.length);
  const problems: CasperProblem[] = [];
  for (const item of list) {
    if (problems.length >= MAX_CASPER_PROBLEMS) break;
    if (!item || typeof item !== 'object') continue;
    const { line, severity, message } = item as Record<string, unknown>;
    if (typeof line !== 'number' || !Number.isInteger(line) || line < o.span.start || line > last || line < 1) continue;
    if (typeof message !== 'string') continue;
    const text = plainMessage(message);
    if (!text) continue;
    if (o.known.some((k) => k.lineNumber === line && sameText(k.message, text))) continue;
    if (problems.some((p) => p.lineNumber === line && sameText(p.message, text))) continue;
    const raw = o.lines[line - 1];
    const startColumn = raw.length - raw.trimStart().length + 1;
    problems.push({
      lineNumber: line,
      startColumn,
      endColumn: Math.max(raw.trimEnd().length + 1, startColumn),
      severity: severityOf(severity),
      message: text,
      code: 'casper',
      source: 'Casper',
      text: raw,
    });
  }
  problems.sort((a, b) => a.lineNumber - b.lineNumber);
  return { ok: true, problems, usage, turnLimit };
}

/**
 * Casper's findings for the tab as it is now. `lineOf(i)` is where the
 * editor tracked finding i's line to (null: the line is gone); without it
 * each finding stays on its line number. A finding is dropped once its line's
 * text changes, so it never lands on a different line that happens to read
 * the same.
 */
export function currentCasperProblems(
  problems: readonly CasperProblem[],
  lines: readonly string[],
  lineOf?: (index: number) => number | null | undefined
): ConfigProblem[] {
  const out: ConfigProblem[] = [];
  problems.forEach((p, i) => {
    const line = lineOf ? lineOf(i) : p.lineNumber;
    if (!line || lines[line - 1] !== p.text) return;
    out.push({
      lineNumber: line,
      startColumn: p.startColumn,
      endColumn: p.endColumn,
      severity: p.severity,
      message: p.message,
      code: p.code,
      source: p.source,
    });
  });
  return out;
}

/** The editor's status line after a check. */
export function casperCheckStatus(
  result: { ok: true; problems: ReadonlyArray<{ severity: ProblemSeverity }>; usage: string | null; turnLimit: boolean } | { ok: false; usage: string | null; turnLimit: boolean }
): string {
  let head: string;
  if (!result.ok) {
    head = result.turnLimit ? 'Casper ran out of turns before it finished. Ask again.' : "Casper didn't send a list of mistakes. Ask again.";
  } else if (!result.problems.length) {
    head = result.turnLimit ? 'Casper ran out of turns before it finished. Ask again.' : 'Casper found no mistakes.';
  } else {
    const count = (s: ProblemSeverity) => result.problems.filter((p) => p.severity === s).length;
    const parts = (
      [
        ['error', 'error', 'errors'],
        ['warning', 'warning', 'warnings'],
        ['info', 'tip', 'tips'],
      ] as const
    )
      .map(([s, one, many]) => [count(s), one, many] as const)
      .filter(([n]) => n > 0)
      .map(([n, one, many]) => `${n} ${n === 1 ? one : many}`);
    head = `Casper marked ${parts.join(', ')}.`;
  }
  return result.usage ? `${head} ${result.usage}` : head;
}
