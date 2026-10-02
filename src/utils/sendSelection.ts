// "Send selected lines" in the Config Editor: which whole lines a selection
// covers, and the prepared send lines inside them (with their real line
// numbers, so the reached-the-switch bars land on the right lines).

import type { SendLine } from './configSafety';

export interface LineSpan {
  start: number;
  end: number;
}

interface SelectionLike {
  startLineNumber: number;
  startColumn: number;
  endLineNumber: number;
  endColumn: number;
}

/** The lines a selection covers; null for a bare cursor. A selection that ends
 *  at the very start of a line (a whole-line drag) leaves that line out, like VS Code. */
export function selectedLines(sel: SelectionLike | null | undefined): LineSpan | null {
  if (!sel) return null;
  const { startLineNumber, startColumn, endLineNumber, endColumn } = sel;
  if (startLineNumber === endLineNumber && startColumn === endColumn) return null;
  const end = endColumn === 1 && endLineNumber > startLineNumber ? endLineNumber - 1 : endLineNumber;
  return { start: startLineNumber, end };
}

export function linesInSpan<T extends Pick<SendLine, 'lineNumber'>>(lines: readonly T[], span: LineSpan): T[] {
  return lines.filter((l) => l.lineNumber >= span.start && l.lineNumber <= span.end);
}

/** The text of those lines, for handing to a Change Job. */
export function spanText(text: string, span: LineSpan): string {
  return text.split('\n').slice(span.start - 1, span.end).join('\n');
}
