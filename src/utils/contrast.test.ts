import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, it, expect } from 'vitest';
import { contrastRatio, relativeLuminance } from './contrast';

// Read the real stylesheet (Vitest stubs CSS imports, even ?raw), so a later
// token tweak that drops below AA fails here.
// (Vitest runs from the project root.)
const themeCss = readFileSync(resolve(process.cwd(), 'src/styles/index.css'), 'utf8');

/** Pull `--name: #hex;` tokens out of one `:root[data-theme='…']` block. */
function themeTokens(theme: 'dark' | 'light'): Record<string, string> {
  const start = themeCss.indexOf(`:root[data-theme='${theme}']`);
  const block = themeCss.slice(start, themeCss.indexOf('\n}', start));
  const tokens: Record<string, string> = {};
  for (const m of block.matchAll(/--([\w-]+):\s*(#[0-9a-f]{3,6})\s*;/gi)) tokens[m[1]] = m[2];
  return tokens;
}

describe('contrast math', () => {
  it('matches the WCAG reference points', () => {
    expect(relativeLuminance('#000')).toBe(0);
    expect(relativeLuminance('#ffffff')).toBeCloseTo(1, 5);
    expect(contrastRatio('#000000', '#ffffff')).toBeCloseTo(21, 5);
    expect(contrastRatio('#777777', '#ffffff')).toBeCloseTo(4.48, 2);
    // Order doesn't matter.
    expect(contrastRatio('#ffffff', '#767676')).toBeCloseTo(contrastRatio('#767676', '#ffffff'), 10);
  });

  it('rejects non-hex input', () => {
    expect(() => relativeLuminance('rgb(0,0,0)')).toThrow();
  });
});

describe.each(['dark', 'light'] as const)('%s theme text tokens', (theme) => {
  const t = themeTokens(theme);
  const surfaces = ['bg-primary', 'bg-secondary', 'bg-tertiary', 'bg-elevated'];

  it('keeps every text level at AA (4.5:1) on every surface', () => {
    for (const text of ['text-primary', 'text-secondary', 'text-muted']) {
      for (const bg of surfaces) {
        expect(contrastRatio(t[text], t[bg]), `${text} on ${bg}`).toBeGreaterThanOrEqual(4.5);
      }
    }
  });

  it('keeps a visible step between secondary and muted text', () => {
    const bg = t['bg-secondary'];
    const secondary = contrastRatio(t['text-secondary'], bg);
    const muted = contrastRatio(t['text-muted'], bg);
    expect(secondary - muted).toBeGreaterThanOrEqual(1.5);
  });

  it('keeps solid danger buttons readable', () => {
    expect(contrastRatio(t['danger-solid-fg'], t['danger-solid'])).toBeGreaterThanOrEqual(4.5);
  });

  it('keeps the CONFIG badge text readable on every surface', () => {
    for (const bg of surfaces) {
      expect(contrastRatio(t['config-mode'], t[bg]), `config-mode on ${bg}`).toBeGreaterThanOrEqual(4.5);
    }
  });

  it('keeps the violet accent readable as text on every surface', () => {
    // AI assistant + API Explorer group labels; the old #d2a8ff was 1.9:1 on white.
    for (const bg of surfaces) {
      expect(contrastRatio(t['accent-violet'], t[bg]), `accent-violet on ${bg}`).toBeGreaterThanOrEqual(4.5);
    }
  });

  it('keeps text on accent-2 (orange) fills readable', () => {
    expect(contrastRatio(t['accent-2-fg'], t['accent-2'])).toBeGreaterThanOrEqual(4.5);
  });
});

describe('theme token parity', () => {
  /** Every `--name:` declared in one `:root[data-theme='…']` block. */
  function declared(theme: 'dark' | 'light'): string[] {
    const start = themeCss.indexOf(`:root[data-theme='${theme}']`);
    const block = themeCss.slice(start, themeCss.indexOf('\n}', start));
    return [...block.matchAll(/--([\w-]+):/g)].map((m) => m[1]).sort();
  }

  it('declares the same tokens in the dark and light blocks', () => {
    // A token only one theme defines resolves to nothing in the other.
    expect(declared('light')).toEqual(declared('dark'));
  });
});
