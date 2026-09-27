import { describe, it, expect } from 'vitest';
import { bufferToText, scrollbackFileName, type BufferLike } from './scrollback';

// Rows as xterm stores them: fixed-width cells (padded with spaces) plus a
// flag saying the row continues the previous one (soft wrap).
function buffer(rows: Array<[string, boolean?]>): BufferLike {
  return {
    length: rows.length,
    getLine: (y) => {
      const row = rows[y];
      if (!row) return undefined;
      const [text, isWrapped = false] = row;
      return {
        isWrapped,
        translateToString: (trimRight?: boolean) => (trimRight ? text.replace(/\s+$/, '') : text),
      };
    },
  };
}

describe('bufferToText', () => {
  it('trims padding, joins soft-wrapped rows and drops trailing blank rows', () => {
    const text = bufferToText(
      buffer([
        ['switch# show vlan      '],
        ['VLAN  Name   Status    '],
        ['10    users  up, a very'],
        [' long line   ', true],
        ['switch#                '],
        ['                       '],
        ['                       '],
      ]),
    );
    expect(text).toBe(
      'switch# show vlan\nVLAN  Name   Status\n10    users  up, a very long line\nswitch#\n',
    );
  });

  it('returns an empty string for an empty terminal', () => {
    expect(bufferToText(buffer([['   '], ['   ']]))).toBe('');
  });
});

describe('scrollbackFileName', () => {
  it('builds a safe, timestamped name', () => {
    const at = new Date(2026, 8, 27, 14, 5);
    expect(scrollbackFileName('core-sw1', at)).toBe('core-sw1-2026-09-27-1405.txt');
    expect(scrollbackFileName('admin@10.0.0.1 / lab', at)).toBe('admin-10.0.0.1-lab-2026-09-27-1405.txt');
    expect(scrollbackFileName('///', at)).toBe('session-2026-09-27-1405.txt');
  });
});
