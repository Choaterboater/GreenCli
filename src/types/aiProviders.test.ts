import { describe, expect, it } from 'vitest';
import { AI_PROVIDERS, DEFAULT_SETTINGS, isCliProvider } from './index';

describe('AI providers', () => {
  it('offers Casper right after Local CLI, with no key', () => {
    const values = AI_PROVIDERS.map((p) => p.value);
    expect(values.indexOf('casper')).toBe(values.indexOf('local-cli') + 1);
    expect(AI_PROVIDERS.find((p) => p.value === 'casper')).toEqual({
      value: 'casper',
      label: 'Casper (no key)',
      needsKey: false,
    });
  });

  it('keeps provider values unique', () => {
    const values = AI_PROVIDERS.map((p) => p.value);
    expect(new Set(values).size).toBe(values.length);
  });

  it('treats only Local CLI and Casper as CLI providers', () => {
    expect(isCliProvider('local-cli')).toBe(true);
    expect(isCliProvider('casper')).toBe(true);
    for (const p of ['anthropic', 'openrouter', 'moonshot', 'ollama', '', undefined, null] as const) {
      expect(isCliProvider(p)).toBe(false);
    }
  });

  it('defaults Casper to `casper` and a fresh folder per question', () => {
    expect(DEFAULT_SETTINGS.casperCommand).toBe('casper');
    expect(DEFAULT_SETTINGS.casperWorkFolder).toBe('');
  });
});
