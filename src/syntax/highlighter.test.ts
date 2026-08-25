import { describe, it, expect } from 'vitest';
import { ArubaHighlighter } from './highlighter';

describe('processLine', () => {
  const hl = ArubaHighlighter.forDeviceType('aruba-cx');

  it('prefers the LONGEST match ("no shutdown" over "no")', () => {
    const tokens = hl.processLine('switch(config)# no shutdown');
    const sub = tokens.find((t) => t.className === 'token-cmd-subcommand');
    expect(sub).toBeDefined();
    expect(sub!.text).toBe('no shutdown');
    // ...and the keyword "no" must NOT be emitted separately for the same span
    expect(tokens.some((t) => t.text === 'no' && t.className === 'token-cmd-keyword')).toBe(false);
  });

  it('matches grammar tokens case-insensitively but preserves original case', () => {
    const tokens = hl.processLine('SHOW VERSION');
    expect(tokens[0]).toMatchObject({ text: 'SHOW', className: 'token-cmd-keyword' });
  });

  it('honours word boundaries (no match inside a longer word)', () => {
    const tokens = hl.processLine('noshutdown');
    // No grammar token may be carved out of the middle of a word
    expect(tokens.every((t) => t.className === 'token-default')).toBe(true);
  });

  it('does not match a keyword when followed by a word character', () => {
    // "showoff" must not tokenize as keyword "show" + "off"
    const tokens = hl.processLine('showoff');
    expect(tokens.some((t) => t.text === 'show' && t.className === 'token-cmd-keyword')).toBe(false);
  });

  it('highlights values (IP addresses)', () => {
    const tokens = hl.processLine('show ip 10.0.0.1');
    expect(tokens.some((t) => t.text === '10.0.0.1' && t.className === 'token-cmd-value')).toBe(true);
  });

  it('detects an Aruba CX config prompt as a prompt token', () => {
    const tokens = hl.processLine('switch(config)# show run');
    expect(tokens[0].className).toBe('token-cmd-prompt');
  });

  it('returns tokens covering the whole line with no gaps', () => {
    const line = 'switch# show interface 1/1/1 | include up';
    const tokens = hl.processLine(line);
    expect(tokens.map((t) => t.text).join('')).toBe(line);
  });
});

describe('detectDeviceType', () => {
  // detectDeviceType is an instance method; the starting grammar doesn't
  // matter for detection (it scores against every built-in grammar).
  const detector = ArubaHighlighter.forDeviceType('generic');

  it('detects Aruba CX from a (config) prompt', () => {
    expect(detector.detectDeviceType('some output\nswitch(config)# ')).toBe('aruba-cx');
  });

  it('detects Junos from a user@host prompt', () => {
    expect(detector.detectDeviceType('user@mx204> ')).toBe('juniper-junos');
  });

  it('detects Junos from an [edit …] line', () => {
    expect(detector.detectDeviceType('[edit interfaces ge-0/0/0]')).toBe('juniper-junos');
  });

  it('falls back to generic for unrecognized output', () => {
    expect(detector.detectDeviceType('hello world, nothing device-like')).toBe('generic');
  });
});
