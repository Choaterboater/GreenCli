import { describe, it, expect } from 'vitest';
import { isRiskyCommand, listNames, riskyLines } from './commandRisk';

describe('isRiskyCommand', () => {
  it('flags commands that change, save or disrupt a device', () => {
    for (const cmd of [
      'reload',
      'reboot',
      'boot system flash primary',
      'erase startup-config',
      'delete /var/tmp/core.0',
      'write memory',
      'write erase',
      'do write mem',
      'copy running-config startup-config',
      'commit',
      'commit confirmed 5',
      'configure terminal',
      'conf t',
      'config',
      'shutdown',
      'shut',
      'no shutdown',
      'no vlan 10',
      'request system reboot',
      'request system zeroize',
      'rollback 1',
    ]) {
      expect(isRiskyCommand(cmd), cmd).toBe(true);
    }
  });

  it('passes reads and harmless session commands', () => {
    for (const cmd of [
      '',
      '   ',
      'show version',
      'sh run',
      'show running-config | include write',
      'show log | match reboot',
      'show configuration',
      'do show ip route',
      'display interface',
      'ping 10.0.0.1',
      'traceroute 10.0.0.1',
      'interface 1/1/1',
      'vlan 10',
      'exit',
      'end',
      'y',
      'terminal length 0',
      'set cli screen-length 0',
      'nothing',
      'show interfaces terse',
    ]) {
      expect(isRiskyCommand(cmd), cmd).toBe(false);
    }
  });
});

describe('riskyLines', () => {
  it('returns only the risky lines, trimmed, in order', () => {
    expect(riskyLines('show version\n  reload \r\nshow vlan\nwrite memory')).toEqual([
      'reload',
      'write memory',
    ]);
    expect(riskyLines('show version\nshow vlan')).toEqual([]);
  });
});

describe('listNames', () => {
  it('lists every name up to the cap, then summarizes', () => {
    expect(listNames(['a', 'b'])).toBe('a, b');
    expect(listNames(['a', 'b', 'c', 'd'], 2)).toBe('a, b and 2 more');
  });
});
