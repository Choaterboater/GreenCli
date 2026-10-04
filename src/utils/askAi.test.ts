import { describe, expect, it } from 'vitest';
import { askMenu, buildAskPrompt, otherVendor, secretLinePairs } from './askAi';

describe('askMenu', () => {
  it('offers Convert only between Aruba and Junos, and Fix only with problems', () => {
    expect(askMenu('aruba-cx', false).map((i) => i.label)).toEqual([
      'Explain these lines',
      'Check them for mistakes',
      'Mark mistakes with Casper',
      'Convert to Junos',
      'Ask something else…',
    ]);
    expect(askMenu('mist', true).map((i) => i.kind)).toEqual(['explain', 'check', 'casper', 'fix', 'convert', 'custom']);
    // Shown always: without Casper, a plain message says so.
    expect(askMenu('yaml', false).find((i) => i.kind === 'casper')?.note).toMatch(/Casper.*secrets hidden.*may cost tokens/);
    expect(askMenu('yaml', false).some((i) => i.kind === 'convert')).toBe(false);
    expect(otherVendor('juniper-junos')).toEqual({ id: 'aruba-cx', label: 'Aruba CX' });
  });
});

describe('buildAskPrompt', () => {
  const base = {
    text: 'interface 1/1/5\n    vlan access 20\n',
    language: 'aruba-cx',
    tabName: 'core-sw1',
    span: { start: 3, end: 4 },
    hidden: 0,
  };

  it('names the lines, fences them, and asks for one code block back', () => {
    const prompt = buildAskPrompt({ ...base, kind: 'convert' });
    expect(prompt).toContain('Convert these Aruba CX lines to Junos.');
    expect(prompt).toContain('From the Config Editor: lines 3–4 of "core-sw1" (Aruba CX).');
    expect(prompt).toContain('```aruba-cx\ninterface 1/1/5\n    vlan access 20\n```');
    expect(prompt).toContain('in ONE ```juniper-junos code block');
  });

  it('says how many secrets are hidden and lists the problems for Fix', () => {
    const prompt = buildAskPrompt({
      ...base,
      kind: 'fix',
      span: null,
      hidden: 2,
      problems: [{ lineNumber: 4, message: 'Unfilled blank' }],
    });
    expect(prompt).toContain('the whole tab of "core-sw1" (Aruba CX). 2 secrets are hidden as <secret hidden>.');
    expect(prompt).toContain('Problems GreenCLI found:\n- line 4: Unfilled blank');
    expect(prompt).toContain('complete new version of the tab');
  });

  it('uses the question typed in, and a code tab keeps its own language name', () => {
    const prompt = buildAskPrompt({ ...base, kind: 'custom', question: 'Why VLAN 20?', language: 'yaml', languageName: 'YAML' });
    expect(prompt.startsWith('Why VLAN 20?')).toBe(true);
    expect(prompt).toContain('(YAML)');
  });

  it('switches fences when the lines hold triple backticks', () => {
    expect(buildAskPrompt({ ...base, kind: 'explain', text: 'echo ```x```' })).toContain('~~~aruba-cx\necho ```x```\n~~~');
  });
});

describe('secretLinePairs', () => {
  it('pairs each hidden line with the real one', () => {
    const original = 'radius-server host 10.1.1.1 key plaintext S3cret\nvlan 20';
    const hidden = 'radius-server host 10.1.1.1 key plaintext <secret hidden>\nvlan 20';
    expect(secretLinePairs(original, hidden)).toEqual([
      ['radius-server host 10.1.1.1 key plaintext <secret hidden>', 'radius-server host 10.1.1.1 key plaintext S3cret'],
    ]);
  });

  it('gives nothing when hiding changed the line count', () => {
    expect(secretLinePairs('a\nb\nc', 'a\n<line hidden: secret>')).toEqual([]);
  });
});
