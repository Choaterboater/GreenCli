import { describe, expect, it } from 'vitest';
import { linesInSpan, selectedLines, spanText } from './sendSelection';
import { prepareSendLines } from './configSafety';

const sel = (startLineNumber: number, startColumn: number, endLineNumber: number, endColumn: number) => ({
  startLineNumber,
  startColumn,
  endLineNumber,
  endColumn,
});

describe('selectedLines', () => {
  it('is null for a bare cursor or no selection', () => {
    expect(selectedLines(sel(3, 5, 3, 5))).toBeNull();
    expect(selectedLines(null)).toBeNull();
  });

  it('covers every line the selection touches', () => {
    expect(selectedLines(sel(2, 4, 4, 2))).toEqual({ start: 2, end: 4 });
    expect(selectedLines(sel(5, 1, 5, 9))).toEqual({ start: 5, end: 5 });
  });

  it('leaves out the last line when a whole-line drag ends at its start', () => {
    expect(selectedLines(sel(2, 1, 5, 1))).toEqual({ start: 2, end: 4 });
  });
});

describe('linesInSpan and spanText', () => {
  const text = ['interface 1/1/1', '    ! uplink', '    description up', '    no shutdown', 'vlan 20'].join('\n');

  it('keeps the real line numbers so the send bars land on the right lines', () => {
    const lines = linesInSpan(prepareSendLines(text), { start: 2, end: 4 });
    expect(lines.map((l) => [l.lineNumber, l.text])).toEqual([
      [3, 'description up'],
      [4, 'no shutdown'],
    ]);
  });

  it('cuts the text of those lines for a Change Job', () => {
    expect(spanText(text, { start: 1, end: 2 })).toBe('interface 1/1/1\n    ! uplink');
  });
});
