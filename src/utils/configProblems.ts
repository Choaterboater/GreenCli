// What the config editor underlines: risky lines, placeholders that still need
// values, terminal junk from a captured log, a password in plain text, the
// Junos "no commit" tip, and a password or token written into a code file.
// Pure (no Monaco import) so it is unit-tested; the editor turns each problem
// into a marker (squiggle, scrollbar mark, F8 stop) and a row in the list.
//
// Built from prepareSendLines, so comment lines — which never go to the
// device — are never flagged.

import { dangerReason, prepareSendLines } from './configSafety';

export type ProblemSeverity = 'error' | 'warning' | 'info';

export interface ConfigProblem {
  /** 1-based, like Monaco. */
  lineNumber: number;
  startColumn: number;
  /** Exclusive, 1-based. */
  endColumn: number;
  severity: ProblemSeverity;
  message: string;
  /** Stable id for the kind of problem ("danger", "placeholder", …). */
  code: string;
  /** Who found it: GreenCLI when unset, "Casper" for Mark mistakes with Casper. */
  source?: string;
}

/** Device config languages: the only ones that get the device checks. */
export const NETWORK_LANGUAGES = new Set([
  'aruba-cx',
  'aruba-aos-s',
  'aruba-ap',
  'aruba-controller',
  'juniper-junos',
  'mist',
  'generic',
]);

/** More than this and the list (and the squiggles) stop; the count says so. */
export const MAX_PROBLEMS = 500;

const ESC = /\x1b/;
const SECRET_MARKER = /<\s*(?:secret\s+hidden|line\s+hidden\s*:\s*secret)\s*>/i;
const PLACEHOLDER = /\$\{[^}\n]+\}|<[^<>\n]{2,}>/g;
const JUNOS_EDIT = /^(?:set|delete|replace|deactivate|activate)\b/i;
// A line about a password, key or community ("password plaintext X",
// "key plaintext X", "auth-pass plaintext X priv-pass plaintext Y").
const SECRET_WORD = /pass|key|secret|psk|community/i;
const PLAINTEXT_VALUE = /\b(?:plaintext|plain-text)\s+("[^"\n]*"|'[^'\n]*'|\S+)/gi;
const JUNOS_COMMIT = /^commit\b/i;

// ─── Secrets written into code and data files ───

/** Code and data files that get the "secret written here" check. */
export const CODE_LANGUAGES = new Set(['yaml', 'json', 'python', 'shell', 'ini', 'javascript', 'typescript', 'powershell', 'hcl']);
// Languages where only a quoted string is a literal value; bare words are code (a variable or a call).
const QUOTED_ONLY = new Set(['python', 'javascript', 'typescript', 'powershell', 'hcl', 'json']);

// A secret-named key, then = or :, then the value. The key may be quoted
// ("api_key": "…"), prefixed (export DB_PASSWORD=…) or dotted (db.password).
const CODE_SECRET =
  /(?:^|[\s{,(])(?:export\s+|\$)?(["']?)([\w.-]*?(?:password|passwd|pwd|secret|token|api[_-]?key|apikey|access[_-]?key|private[_-]?key|(?:radius|tacacs|shared|wpa|auth|enc(?:ryption)?)[_-]?key|psk|community)(?:[_.-][\w.-]*)?)\1\s*(?::=|:|=)\s*(.*)$/i;
// Names that hold something about a secret, not the secret.
const NOT_A_SECRET_NAME = /(?:[_.-]|^)(?:file|path|env|var|name|prompt|length|len|policy|url|uri|type|field|label|hint|regex|required|min|max|count|id)$/i;
// Values that point at the secret instead of holding it.
const NOT_A_SECRET_VALUE =
  /^(?:\$\{|\$[A-Za-z_(]|\{\{|%\(|<[^>]*>$|!vault|vault:|os\.|getenv|process\.env|env\(|lookup\(|secrets?\.|none$|null$|nil$|true$|false$|\*+$|x{3,}$)/i;
const UI_TEXT_LANGUAGES = new Set(['json', 'javascript', 'typescript']);
const CODE_COMMENT = /^\s*(?:#|\/\/|;|--|\/\*|\*)/;

/** The value in "…", '…' or bare up to a trailing comment, with its start column (0-based). */
function codeValue(rest: string, restStart: number, language: string): { value: string; start: number } | undefined {
  const quote = rest[0];
  if (quote === '"' || quote === "'") {
    const end = rest.indexOf(quote, 1);
    if (end < 0) return undefined;
    return { value: rest.slice(1, end), start: restStart + 1 };
  }
  if (QUOTED_ONLY.has(language)) return undefined;
  const bare = rest.replace(/\s+#.*$/, '').replace(/[;,]\s*$/, '').trimEnd();
  return bare ? { value: bare, start: restStart } : undefined;
}

function codeSecretProblem(raw: string, lineNumber: number, language: string): ConfigProblem | undefined {
  if (CODE_COMMENT.test(raw)) return undefined;
  const match = CODE_SECRET.exec(raw);
  if (!match || NOT_A_SECRET_NAME.test(match[2])) return undefined;
  const rest = match[3];
  const found = codeValue(rest.trim(), raw.length - rest.length + (rest.length - rest.trimStart().length), language);
  if (!found || found.value.length < 3 || NOT_A_SECRET_VALUE.test(found.value.trim())) return undefined;
  // In JSON and JS/TS a value with spaces is a UI label ("Enter your password"), not a secret.
  if (UI_TEXT_LANGUAGES.has(language) && /\s/.test(found.value)) return undefined;
  return {
    lineNumber,
    startColumn: found.start + 1,
    endColumn: found.start + found.value.length + 1,
    severity: 'warning',
    message: 'A password, key or token is written in this file. Keep it in a vault or an environment variable instead.',
    code: 'code-secret',
  };
}

function indentEnd(raw: string): number {
  return raw.length - raw.trimStart().length + 1;
}

/**
 * The problems in an editor buffer, in line order. Device checks run only for
 * device config languages and plain text (a config pasted before the language
 * is picked); code files only get the terminal-junk check.
 */
export function buildProblems(text: string, language: string): ConfigProblem[] {
  const problems: ConfigProblem[] = [];
  const rawLines = text.split('\n');
  const add = (problem: ConfigProblem) => {
    if (problems.length < MAX_PROBLEMS) problems.push(problem);
  };

  // Terminal escape codes: anywhere, on any language (a pasted PuTTY log).
  rawLines.forEach((raw, index) => {
    const at = raw.search(ESC);
    if (at < 0) return;
    add({
      lineNumber: index + 1,
      startColumn: at + 1,
      endColumn: raw.length + 1,
      severity: 'warning',
      message: 'Terminal escape codes from a captured log. Use Clean to strip them before sending.',
      code: 'ansi',
    });
  });

  const device = NETWORK_LANGUAGES.has(language) || language === 'plaintext';
  if (device) {
    const sendLines = prepareSendLines(text);
    for (const line of sendLines) {
      const raw = rawLines[line.lineNumber - 1] ?? line.text;
      const reason = dangerReason(line.text);
      if (reason) {
        add({
          lineNumber: line.lineNumber,
          startColumn: indentEnd(raw),
          endColumn: raw.trimEnd().length + 1,
          severity: 'warning',
          message: `Risky: this ${reason}. Check it before you send.`,
          code: 'danger',
        });
      }
      PLACEHOLDER.lastIndex = 0;
      for (let match = PLACEHOLDER.exec(raw); match; match = PLACEHOLDER.exec(raw)) {
        const secret = SECRET_MARKER.test(match[0]);
        add({
          lineNumber: line.lineNumber,
          startColumn: match.index + 1,
          endColumn: match.index + match[0].length + 1,
          severity: 'error',
          message: secret
            ? 'This is a hidden-secret marker, not the real value. Sending it would set the secret to this text.'
            : `Fill in ${match[0]} before sending: the switch would get this text as it is.`,
          code: secret ? 'secret-marker' : 'placeholder',
        });
      }
      if (SECRET_WORD.test(raw)) {
        PLAINTEXT_VALUE.lastIndex = 0;
        for (let match = PLAINTEXT_VALUE.exec(raw); match; match = PLAINTEXT_VALUE.exec(raw)) {
          const value = match[1];
          // A blank or a hidden-secret marker is already an error above.
          if (/^["']?(?:\$\{|<)/.test(value)) continue;
          const start = match.index + match[0].length - value.length;
          add({
            lineNumber: line.lineNumber,
            startColumn: start + 1,
            endColumn: start + value.length + 1,
            severity: 'info',
            message: 'A password or key in plain text. Use Copy with secrets hidden before you share this file.',
            code: 'plaintext-secret',
          });
        }
      }
    }

    if (language === 'juniper-junos' || language === 'mist') {
      const edits = sendLines.filter((line) => JUNOS_EDIT.test(line.text));
      if (edits.length && !sendLines.some((line) => JUNOS_COMMIT.test(line.text))) {
        const last = edits[edits.length - 1];
        const raw = rawLines[last.lineNumber - 1] ?? last.text;
        add({
          lineNumber: last.lineNumber,
          startColumn: indentEnd(raw),
          endColumn: raw.trimEnd().length + 1,
          severity: 'info',
          message:
            'Junos changes do nothing until a commit. Use Send safely (arrow next to Send): it commits with a rollback timer and confirms for you. Or add "commit confirmed 5": it rolls back in 5 minutes unless you commit again.',
          code: 'junos-commit',
        });
      }
    }
  }

  if (CODE_LANGUAGES.has(language)) {
    rawLines.forEach((raw, index) => {
      const problem = codeSecretProblem(raw, index + 1, language);
      if (problem) add(problem);
    });
  }

  return problems.sort((a, b) => a.lineNumber - b.lineNumber || a.startColumn - b.startColumn);
}

/** The line the switch rejected on the last Send, with the switch's own words. */
export function rejectedLineProblem(text: string, lineNumber: number, deviceText: string): ConfigProblem | undefined {
  const raw = text.split('\n')[lineNumber - 1];
  if (raw === undefined || !raw.trim()) return undefined;
  const said = deviceText
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .slice(0, 2)
    .join(' ');
  return {
    lineNumber,
    startColumn: indentEnd(raw),
    endColumn: raw.trimEnd().length + 1,
    severity: 'error',
    message: said ? `The switch rejected this line: ${said}` : 'The switch rejected this line.',
    code: 'rejected',
  };
}

const SEVERITY_ORDER: Record<ProblemSeverity, number> = { error: 0, warning: 1, info: 2 };
const SEVERITY_WORD: Record<ProblemSeverity, string> = { error: 'Error', warning: 'Warning', info: 'Tip' };

/**
 * The problem part of the Send dialog: the count, then the first few, errors
 * first, each with its line. Empty when there are none.
 */
export function sendProblemNote(problems: readonly ConfigProblem[], max = 5): string {
  if (!problems.length) return '';
  const ordered = [...problems].sort(
    (a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity] || a.lineNumber - b.lineNumber
  );
  const shown = ordered.slice(0, max).map((p) => `${SEVERITY_WORD[p.severity]}, line ${p.lineNumber}: ${p.message}`);
  const more = ordered.length - shown.length;
  return [
    `${problemSummary(problems)}:`,
    ...shown,
    ...(more > 0 ? [`…and ${more} more in the Problems panel.`] : []),
  ].join('\n');
}

/** "1 error, 3 warnings, 1 tip" — empty when there are none. */
export function problemSummary(problems: readonly ConfigProblem[]): string {
  const count = (severity: ProblemSeverity) => problems.filter((p) => p.severity === severity).length;
  const parts: string[] = [];
  const errors = count('error');
  const warnings = count('warning');
  const tips = count('info');
  if (errors) parts.push(`${errors} ${errors === 1 ? 'error' : 'errors'}`);
  if (warnings) parts.push(`${warnings} ${warnings === 1 ? 'warning' : 'warnings'}`);
  if (tips) parts.push(`${tips} ${tips === 1 ? 'tip' : 'tips'}`);
  return parts.join(', ');
}

/** What the toolbar shows: the counts, a "No problems" tick, or nothing. */
export type ProblemBadge = 'counts' | 'clean' | 'none';

/**
 * Counts whenever something was found. The tick only on a device config
 * with text in it: code files and plain text get lighter checks, so a tick
 * there would promise more than was checked.
 */
export function problemBadge(problems: readonly ConfigProblem[], language: string, text: string): ProblemBadge {
  if (problems.length > 0) return 'counts';
  if (!text.trim()) return 'none';
  return NETWORK_LANGUAGES.has(language) ? 'clean' : 'none';
}
