import { describe, expect, it } from 'vitest';
import { LOCAL_CLI_PRESETS } from './index';

describe('LOCAL_CLI_PRESETS', () => {
  it('offers Casper, started by name with no arguments', () => {
    const casper = LOCAL_CLI_PRESETS.find((p) => p.id === 'casper');
    expect(casper).toEqual({ id: 'casper', label: 'Casper', command: 'casper' });
  });

  it('keeps ids unique', () => {
    const ids = LOCAL_CLI_PRESETS.map((p) => p.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});
