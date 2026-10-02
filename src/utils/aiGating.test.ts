import { describe, it, expect } from 'vitest';
import { aiIsWriteCommand, CONTROL_CHARS, normalizeLineBreaks } from './aiGating';

describe('aiIsWriteCommand', () => {
  it('flags obvious writes', () => {
    expect(aiIsWriteCommand('configure terminal')).toBe(true);
    expect(aiIsWriteCommand('configure')).toBe(true);
    expect(aiIsWriteCommand('conf t')).toBe(true);
    expect(aiIsWriteCommand('delete vlan 10')).toBe(true);
    expect(aiIsWriteCommand('write memory')).toBe(true);
    expect(aiIsWriteCommand('commit')).toBe(true);
    expect(aiIsWriteCommand('commit confirmed')).toBe(true);
    expect(aiIsWriteCommand('erase startup-config')).toBe(true);
    expect(aiIsWriteCommand('reload')).toBe(true);
    expect(aiIsWriteCommand('copy running-config startup-config')).toBe(true);
  });

  it('flags unknown verbs (fail-safe)', () => {
    expect(aiIsWriteCommand('set interfaces ge-0/0/0 unit 0 family inet')).toBe(true);
    expect(aiIsWriteCommand('no shutdown')).toBe(true);
    expect(aiIsWriteCommand('vlan 100')).toBe(true);
    expect(aiIsWriteCommand('interface 1/1/1')).toBe(true);
  });

  it('passes obvious reads without confirmation', () => {
    expect(aiIsWriteCommand('show running-config')).toBe(false);
    expect(aiIsWriteCommand('show version')).toBe(false);
    expect(aiIsWriteCommand('sh int status')).toBe(false);
    expect(aiIsWriteCommand('display interfaces')).toBe(false);
    expect(aiIsWriteCommand('get system information')).toBe(false);
    expect(aiIsWriteCommand('ping 10.0.0.1')).toBe(false);
    expect(aiIsWriteCommand('traceroute 8.8.8.8')).toBe(false);
    expect(aiIsWriteCommand('do show vlan')).toBe(false);
  });

  it('treats multi-line commands as write when ANY line writes', () => {
    expect(aiIsWriteCommand('show version\ncommit')).toBe(true);
    expect(aiIsWriteCommand('show version\nshow vlan')).toBe(false);
    expect(aiIsWriteCommand('\n\nshow version\n')).toBe(false);
  });

  it('splits on a bare \\r too (the device treats it as Enter)', () => {
    expect(aiIsWriteCommand('show version\rconfigure terminal\rinterface 1/1/1\rshutdown')).toBe(true);
    expect(aiIsWriteCommand('show version\r\nreload')).toBe(true);
    expect(aiIsWriteCommand('show version\rshow vlan')).toBe(false);
  });

  it('treats control characters as a write (backspace, Ctrl-U, Ctrl-Z, Tab, ESC)', () => {
    expect(aiIsWriteCommand('show\b\b\b\bconf t')).toBe(true);
    expect(aiIsWriteCommand('show version\x15configure')).toBe(true);
    expect(aiIsWriteCommand('show vlan\x1a')).toBe(true);
    expect(aiIsWriteCommand('sh\tconf')).toBe(true);
    expect(aiIsWriteCommand('show \x1b[A')).toBe(true);
  });
});

describe('CONTROL_CHARS', () => {
  it('ignores line breaks and printable text', () => {
    expect(CONTROL_CHARS.test('show version\nshow vlan\r\n')).toBe(false);
    expect(CONTROL_CHARS.test('show interface 1/1/1 | include "up"')).toBe(false);
  });
});

describe('normalizeLineBreaks', () => {
  it('turns every line break into \\n so the dialog shows each line', () => {
    expect(normalizeLineBreaks('a\rb\r\nc\nd')).toBe('a\nb\nc\nd');
  });
});
