// Quick fixes (Ctrl+. or the light bulb) for the Config Editor's problems.
// Pure: each fix is a list of plain text edits, so it is unit-tested; the
// providers file turns them into Monaco code actions.

import type { ConfigProblem } from '../utils/configProblems';
import { stripAnsi } from '../utils/terminal';

export interface FixEdit {
  startLineNumber: number;
  startColumn: number;
  endLineNumber: number;
  endColumn: number;
  text: string;
}

export interface QuickFix {
  title: string;
  edits: FixEdit[];
  /** The one Ctrl+. offers first. */
  preferred?: boolean;
}

const JUNOS = new Set(['juniper-junos', 'mist']);

type ProblemSpot = Pick<ConfigProblem, 'lineNumber' | 'startColumn' | 'endColumn' | 'code'>;

/** The blank a plain-text secret becomes: ${password}, ${key}, ${auth_pass}. */
function blankName(before: string): string {
  const word = /([\w-]+)\s+(?:plaintext|plain-text)\s*$/i.exec(before)?.[1] ?? '';
  return word.replace(/[^a-z0-9]+/gi, '_').toLowerCase() || 'secret';
}

export function quickFixesFor(problem: ProblemSpot, text: string, language: string): QuickFix[] {
  const lines = text.split('\n');
  const line = lines[problem.lineNumber - 1];
  if (line === undefined) return [];
  switch (problem.code) {
    case 'ansi': {
      const last = lines.length;
      return [
        {
          title: 'Strip terminal escape codes from this tab',
          preferred: true,
          edits: [{ startLineNumber: 1, startColumn: 1, endLineNumber: last, endColumn: lines[last - 1].length + 1, text: stripAnsi(text) }],
        },
      ];
    }
    case 'danger':
    case 'rejected': {
      const at = line.length - line.trimStart().length + 1;
      return [
        {
          title: "Comment out this line (it won't be sent)",
          edits: [{ startLineNumber: problem.lineNumber, startColumn: at, endLineNumber: problem.lineNumber, endColumn: at, text: JUNOS.has(language) ? '# ' : '! ' }],
        },
      ];
    }
    case 'junos-commit': {
      const last = lines.length;
      const endsWithNewline = text.endsWith('\n');
      const column = lines[last - 1].length + 1;
      return [
        {
          title: 'Add "commit confirmed 5" at the end (it rolls back in 5 minutes unless you commit again)',
          preferred: true,
          edits: [
            {
              startLineNumber: last,
              startColumn: column,
              endLineNumber: last,
              endColumn: column,
              text: endsWithNewline ? 'commit confirmed 5\n' : '\ncommit confirmed 5',
            },
          ],
        },
      ];
    }
    case 'plaintext-secret': {
      const name = blankName(line.slice(0, problem.startColumn - 1));
      return [
        {
          title: `Replace with a blank to fill in (\${${name}})`,
          edits: [
            {
              startLineNumber: problem.lineNumber,
              startColumn: problem.startColumn,
              endLineNumber: problem.lineNumber,
              endColumn: problem.endColumn,
              text: `\${${name}}`,
            },
          ],
        },
      ];
    }
    default:
      return [];
  }
}
