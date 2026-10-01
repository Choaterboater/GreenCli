// What the config editor underlines: risky lines, placeholders that still need
// values, terminal junk from a captured log, and the Junos "no commit" tip.
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
const JUNOS_COMMIT = /^commit\b/i;

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
            'Junos changes do nothing until a commit. Add "commit confirmed 5" so the box rolls back if you lose access.',
          code: 'junos-commit',
        });
      }
    }
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
