import { describe, expect, it } from 'vitest';
import { isOtherVendor, locateTarget, restoreSecrets, withSuggestion } from './aiReview';

describe('restoreSecrets', () => {
  const pairs: Array<[string, string]> = [
    ['radius-server host 10.1.1.10 key plaintext <secret hidden> vrf mgmt', 'radius-server host 10.1.1.10 key plaintext Rad1us vrf mgmt'],
  ];

  it('puts the real line back where the AI kept it, in its new indent', () => {
    const code = 'vlan 20\n  radius-server host 10.1.1.10 key plaintext <secret hidden> vrf mgmt';
    expect(restoreSecrets(code, pairs)).toEqual({
      text: 'vlan 20\n  radius-server host 10.1.1.10 key plaintext Rad1us vrf mgmt',
      restored: 1,
      markersLeft: 0,
    });
  });

  it('leaves a marker the AI changed the line around, and counts it', () => {
    const code = 'radius-server host 10.1.1.20 key plaintext <secret hidden> vrf mgmt';
    expect(restoreSecrets(code, pairs)).toEqual({ text: code, restored: 0, markersLeft: 1 });
  });
});

describe('locateTarget', () => {
  const tab = 'hostname sw1\ninterface 1/1/5\n    vlan access 20\nvlan 20';

  it('finds the lines where they were, or where they moved', () => {
    expect(locateTarget(tab, 'interface 1/1/5\n    vlan access 20', { start: 2, end: 3 })).toEqual({ start: 2, end: 3 });
    expect(locateTarget('! new line\n' + tab, 'interface 1/1/5\n    vlan access 20', { start: 2, end: 3 })).toEqual({ start: 3, end: 4 });
  });

  it('gives up when the lines were changed, and covers the whole tab for a whole-tab question', () => {
    expect(locateTarget(tab, 'interface 1/1/6\n    vlan access 20', { start: 2, end: 3 })).toBeNull();
    expect(locateTarget(tab, 'anything', null)).toEqual({ start: 1, end: 4 });
  });
});

describe('withSuggestion', () => {
  it('replaces just those lines', () => {
    expect(withSuggestion('a\nb\nc\nd', { start: 2, end: 3 }, 'B1\nB2\nB3\n')).toBe('a\nB1\nB2\nB3\nd');
  });

  it('keeps the tab\'s final newline when the whole tab is replaced', () => {
    expect(withSuggestion('a\nb\n', { start: 1, end: 3 }, 'x\ny')).toBe('x\ny\n');
  });
});

describe('isOtherVendor', () => {
  it('sends a Junos answer for an Aruba tab to a new tab, but not a plain or same-family block', () => {
    expect(isOtherVendor('juniper-junos', 'aruba-cx')).toBe(true);
    expect(isOtherVendor('junos', 'mist')).toBe(false);
    expect(isOtherVendor('text', 'aruba-cx')).toBe(false);
    expect(isOtherVendor(undefined, 'aruba-cx')).toBe(false);
    expect(isOtherVendor('aruba-cx', 'yaml')).toBe(false);
  });
});
