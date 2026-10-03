import { describe, expect, it } from 'vitest';
import { isLabHost, LAB_TAG, normalizeTags } from './tags';
import { parseHostsCsv } from './importHosts';

describe('tags: the reserved lab tag', () => {
  it('is spelled one way, whatever was typed, and listed first', () => {
    expect(LAB_TAG).toBe('lab');
    expect(normalizeTags([' core ', 'LAB', '', 'site-a', 'Lab', 'core'])).toEqual(['lab', 'core', 'site-a']);
    expect(normalizeTags(['laboratory', 'lab-2'])).toEqual(['laboratory', 'lab-2']);
  });

  it('marks a lab host only by the exact tag', () => {
    expect(isLabHost({ tags: ['core', 'Lab'] })).toBe(true);
    expect(isLabHost({ tags: ['labs'] })).toBe(false);
    expect(isLabHost({})).toBe(false);
  });
});

describe('imports keep the lab tag in its one spelling', () => {
  it('a CSV with LAB in its tags column imports as lab', () => {
    const { hosts } = parseHostsCsv('name,host,tags\nsw1,10.0.0.1,core;LAB\n');
    expect(hosts[0]?.tags).toEqual(['lab', 'core']);
  });
});
