import { describe, expect, it } from 'vitest';
import { buildProblems } from '../utils/configProblems';
import { quickFixesFor, type FixEdit } from './quickFixes';

/** Apply edits the way Monaco does (all against the original text). */
function apply(text: string, edits: FixEdit[]): string {
  const lines = text.split('\n');
  const offset = (line: number, column: number) => lines.slice(0, line - 1).reduce((n, l) => n + l.length + 1, 0) + column - 1;
  return [...edits]
    .sort((a, b) => offset(b.startLineNumber, b.startColumn) - offset(a.startLineNumber, a.startColumn))
    .reduce((out, e) => out.slice(0, offset(e.startLineNumber, e.startColumn)) + e.text + out.slice(offset(e.endLineNumber, e.endColumn)), text);
}

function fix(text: string, language: string, code: string) {
  const problem = buildProblems(text, language).find((p) => p.code === code);
  if (!problem) throw new Error(`no ${code} problem`);
  const [first] = quickFixesFor(problem, text, language);
  return { title: first.title, result: apply(text, first.edits) };
}

describe('quick fixes', () => {
  it('strips terminal junk from the whole tab', () => {
    const text = 'sw1# \x1b[1mshow run\x1b[0m\ninterface 1/1/1\n';
    expect(fix(text, 'aruba-cx', 'ansi')).toEqual({
      title: 'Strip terminal escape codes from this tab',
      result: 'sw1# show run\ninterface 1/1/1\n',
    });
  });

  it('comments out a risky line, keeping its indent, with the vendor comment mark', () => {
    expect(fix('interface 1/1/1\n    shutdown\n', 'aruba-cx', 'danger').result).toBe('interface 1/1/1\n    ! shutdown\n');
    expect(fix('set system host-name a\nrequest system reboot\ncommit\n', 'juniper-junos', 'danger').result).toBe(
      'set system host-name a\n# request system reboot\ncommit\n'
    );
  });

  it('comments out the line the switch rejected', () => {
    const problem = { lineNumber: 2, startColumn: 3, endColumn: 12, code: 'rejected' };
    const [first] = quickFixesFor(problem, 'vlan 10\n  nme users\n', 'aruba-cx');
    expect(apply('vlan 10\n  nme users\n', first.edits)).toBe('vlan 10\n  ! nme users\n');
  });

  it('adds commit confirmed 5 at the end of a Junos tab', () => {
    expect(fix('set vlans users vlan-id 20\n', 'juniper-junos', 'junos-commit').result).toBe(
      'set vlans users vlan-id 20\ncommit confirmed 5\n'
    );
    expect(fix('set vlans users vlan-id 20', 'mist', 'junos-commit').result).toBe('set vlans users vlan-id 20\ncommit confirmed 5');
  });

  it('turns a plain-text secret into a blank named after it', () => {
    expect(fix('user admin group administrators password plaintext Sup3r!', 'aruba-cx', 'plaintext-secret')).toEqual({
      title: 'Replace with a blank to fill in (${password})',
      result: 'user admin group administrators password plaintext ${password}',
    });
    expect(fix('radius-server host 10.1.1.10 key plaintext "Rad Key" vrf mgmt', 'aruba-cx', 'plaintext-secret').result).toBe(
      'radius-server host 10.1.1.10 key plaintext ${key} vrf mgmt'
    );
    const snmp = 'snmpv3 user ops auth sha auth-pass plaintext A1b2 priv aes priv-pass plaintext P2q3';
    expect(fix(snmp, 'aruba-cx', 'plaintext-secret').result).toContain('auth-pass plaintext ${auth_pass} priv');
  });

  it('offers nothing for problems it has no fix for', () => {
    expect(quickFixesFor({ lineNumber: 1, startColumn: 1, endColumn: 5, code: 'placeholder' }, 'vlan ${id}', 'aruba-cx')).toEqual([]);
    expect(quickFixesFor({ lineNumber: 9, startColumn: 1, endColumn: 5, code: 'danger' }, 'reload', 'aruba-cx')).toEqual([]);
  });
});
