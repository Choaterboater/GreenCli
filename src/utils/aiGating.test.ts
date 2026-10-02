import { describe, it, expect } from 'vitest';
import { AUDITOR_REFUSAL, aiIsWriteCommand, CONTROL_CHARS, isReadOnlyAgent, normalizeLineBreaks } from './aiGating';
import { BUILTIN_AGENTS } from '../types';

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

describe('isReadOnlyAgent', () => {
  const auditor = BUILTIN_AGENTS[0];
  it('covers the built-in Read-only Auditor', () => {
    expect(auditor.id).toBe('agent-auditor');
    expect(auditor.readOnly).toBe(true);
    expect(isReadOnlyAgent(auditor)).toBe(true);
  });
  it('covers an Auditor saved before the flag, or renamed', () => {
    expect(isReadOnlyAgent({ id: 'agent-auditor', name: 'Read-only Auditor' })).toBe(true);
    expect(isReadOnlyAgent({ id: 'agent-auditor', name: 'My audits' })).toBe(true);
  });
  it('covers one re-created by name', () => {
    expect(isReadOnlyAgent({ id: 'agent-123', name: '  read-only AUDITOR ' })).toBe(true);
  });
  it('honours the readOnly flag', () => {
    expect(isReadOnlyAgent({ id: 'agent-9', name: 'Night shift', readOnly: true })).toBe(true);
  });
  it('leaves other agents and no agent alone', () => {
    expect(isReadOnlyAgent(BUILTIN_AGENTS[1])).toBe(false);
    expect(isReadOnlyAgent({ id: 'agent-9', name: 'Junos Expert', readOnly: false })).toBe(false);
    expect(isReadOnlyAgent(undefined)).toBe(false);
  });
  it('tells the model what to do instead', () => {
    expect(AUDITOR_REFUSAL.startsWith('Not run: ')).toBe(true);
    expect(AUDITOR_REFUSAL).toContain('Give the user the exact commands to run instead.');
  });
});
