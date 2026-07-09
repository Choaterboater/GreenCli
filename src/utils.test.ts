import { describe, it, expect } from 'vitest';
import { formatBytes, clamp, fuzzyScore, fuzzyMatch, shellQuote } from './utils';

describe('utils', () => {
  describe('formatBytes', () => {
    it('formats bytes correctly', () => {
      expect(formatBytes(0)).toBe('0 B');
      expect(formatBytes(1024)).toBe('1 KB');
      expect(formatBytes(1024 * 1024)).toBe('1 MB');
      expect(formatBytes(1024 * 1024 * 1024)).toBe('1 GB');
      expect(formatBytes(1536)).toBe('1.5 KB'); // 1.5 * 1024
    });
  });

  describe('clamp', () => {
    it('clamps values within range', () => {
      expect(clamp(5, 1, 10)).toBe(5);
      expect(clamp(0, 1, 10)).toBe(1);
      expect(clamp(15, 1, 10)).toBe(10);
    });
  });

  describe('fuzzyMatch', () => {
    it('matches exact and sub-strings case-insensitively', () => {
      expect(fuzzyMatch('test', 'Testing')).toBe(true);
      expect(fuzzyMatch('Tst', 'Testing')).toBe(true); // subsequences match
      expect(fuzzyMatch('xyz', 'Testing')).toBe(false);
    });
    it('ignores hyphens and spaces', () => {
      expect(fuzzyMatch('my test', 'my-test-case')).toBe(true);
    });
  });

  describe('shellQuote', () => {
    it('returns simple paths unquoted', () => {
      expect(shellQuote('/usr/bin/local')).toBe('/usr/bin/local');
      expect(shellQuote('~/.ssh/config')).toBe('~/.ssh/config');
    });

    it('quotes paths with spaces', () => {
      expect(shellQuote('/My Documents/folder')).toBe("'/My Documents/folder'");
    });

    it('handles embedded quotes correctly', () => {
      expect(shellQuote("path/with/'quote")).toBe("'path/with/'\\''quote'");
    });
  });
});
