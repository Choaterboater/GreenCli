import { describe, it, expect } from 'vitest';
import {
  AUDITOR_REFUSAL,
  aiIsWriteCommand,
  auditorAllowsCommand,
  CONTROL_CHARS,
  isReadOnlyAgent,
  normalizeLineBreaks,
} from './aiGating';
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

describe('file-writing pipes and redirects', () => {
  it('asks before a read that writes a file', () => {
    expect(aiIsWriteCommand('show configuration | save /var/tmp/c.txt')).toBe(true);
    expect(aiIsWriteCommand('show log messages | save /var/log/messages')).toBe(true);
    expect(aiIsWriteCommand('show log messages | s /var/log/messages')).toBe(true);
    expect(aiIsWriteCommand('show configuration | append /var/tmp/c.txt')).toBe(true);
    expect(aiIsWriteCommand('show configuration | tee /var/tmp/c.txt')).toBe(true);
    expect(aiIsWriteCommand('show running-config | redirect flash:x')).toBe(true);
    expect(aiIsWriteCommand('echo x > /etc/motd')).toBe(true);
    expect(aiIsWriteCommand('cat a >> b')).toBe(true);
  });

  it('still passes safe pipes', () => {
    expect(aiIsWriteCommand('show interfaces terse | match ge-')).toBe(false);
    expect(aiIsWriteCommand('show configuration | display set | no-more')).toBe(false);
    expect(aiIsWriteCommand('show running-config | include hostname')).toBe(false);
    expect(aiIsWriteCommand('show version | trim 5')).toBe(false);
  });
});

describe('auditorAllowsCommand', () => {
  it('allows plain reads and safe pipes', () => {
    expect(auditorAllowsCommand('show version')).toBe(true);
    expect(auditorAllowsCommand('show configuration | display set | no-more')).toBe(true);
    expect(auditorAllowsCommand('show interfaces terse | match ge- | count')).toBe(true);
    expect(auditorAllowsCommand('show running-config | include hostname')).toBe(true);
    expect(auditorAllowsCommand('sh run | inc vlan')).toBe(true);
    expect(auditorAllowsCommand('cat /var/log/messages | grep error | tail -n 20')).toBe(true);
    expect(auditorAllowsCommand('ping 10.0.0.1 count 5')).toBe(true);
    expect(auditorAllowsCommand('show version\nshow vlan')).toBe(true);
  });

  it('refuses writes, file-writing pipes and shell tricks', () => {
    expect(auditorAllowsCommand('configure')).toBe(false);
    expect(auditorAllowsCommand('show configuration | save /var/tmp/c.txt')).toBe(false);
    expect(auditorAllowsCommand('show log messages | save /var/log/messages')).toBe(false);
    expect(auditorAllowsCommand('show log messages | s /var/log/messages')).toBe(false);
    expect(auditorAllowsCommand('show configuration | compare rollback 1')).toBe(false);
    expect(auditorAllowsCommand('show version | request message all message hi')).toBe(false);
    expect(auditorAllowsCommand('cat a | sort -o b')).toBe(false);
    expect(auditorAllowsCommand('show version || reboot')).toBe(false);
    expect(auditorAllowsCommand('echo x > file')).toBe(false);
    expect(auditorAllowsCommand('cat a; rm b')).toBe(false);
    expect(auditorAllowsCommand('show version & reboot')).toBe(false);
    expect(auditorAllowsCommand('echo `reboot`')).toBe(false);
    expect(auditorAllowsCommand('echo $(reboot)')).toBe(false);
    expect(auditorAllowsCommand('cat <(reboot)')).toBe(false);
    expect(auditorAllowsCommand('set system host-name x')).toBe(false);
    expect(auditorAllowsCommand('show version\nrequest system reboot')).toBe(false);
    expect(auditorAllowsCommand('show version\x1a')).toBe(false);
  });

  it('refuses reads that change a Linux box or never end', () => {
    expect(auditorAllowsCommand('date -s "2020-01-01 00:00"')).toBe(false);
    expect(auditorAllowsCommand('date --set=2020-01-01')).toBe(false);
    expect(auditorAllowsCommand('date 010100002020')).toBe(false);
    expect(auditorAllowsCommand('less /var/log/x')).toBe(false);
    expect(auditorAllowsCommand('more /etc/passwd')).toBe(false);
    expect(auditorAllowsCommand('monitor traffic interface ge-0/0/0')).toBe(false);
    expect(auditorAllowsCommand('tail -f /var/log/x')).toBe(false);
    expect(auditorAllowsCommand('tail -fn 20 /var/log/x')).toBe(false);
    expect(auditorAllowsCommand('tail --follow=name /var/log/x')).toBe(false);
    expect(auditorAllowsCommand('cat /var/log/x | tail -f')).toBe(false);
    // The old +Nf form: start at line N, then follow.
    for (const cmd of ['tail +1f /etc/hostname', 'tail +f /var/log/x', 'tail +10F /var/log/x', 'tail -q +1f x', 'show log | tail +5f']) {
      expect([cmd, auditorAllowsCommand(cmd)]).toEqual([cmd, false]);
    }
    // Plain shows of the same words still pass.
    expect(auditorAllowsCommand('date')).toBe(true);
    expect(auditorAllowsCommand('date -u +%F')).toBe(true);
    expect(auditorAllowsCommand('tail -n 50 /var/log/x')).toBe(true);
    expect(auditorAllowsCommand('show log messages | last 20')).toBe(true);
  });

  it('refuses ping without a count, which runs until Ctrl-C', () => {
    for (const cmd of ['ping 8.8.8.8', 'do ping 8.8.8.8', 'ping -n 8.8.8.8', 'ping -c 0 8.8.8.8', 'ping 8.8.8.8 count', 'ping']) {
      expect([cmd, auditorAllowsCommand(cmd)]).toEqual([cmd, false]);
    }
    for (const cmd of [
      'ping -c 4 8.8.8.8',
      'ping -c4 8.8.8.8',
      'ping 8.8.8.8 -c 3',
      'ping -n 4 8.8.8.8',
      'ping 10.0.0.1 count 5',
      'ping 10.0.0.1 repetitions 5',
      'ping 10.0.0.1 repeat 5',
      'do ping 10.0.0.1 repetitions 3',
    ]) {
      expect([cmd, auditorAllowsCommand(cmd)]).toEqual([cmd, true]);
    }
    // traceroute ends by itself.
    expect(auditorAllowsCommand('traceroute 8.8.8.8')).toBe(true);
  });

  it('refuses cat, head and tail with no file, which wait on the keyboard', () => {
    for (const cmd of ['cat', 'cat -', 'cat -n', 'head', 'head -n 20', 'tail', 'tail -n 50', 'tail -c 100 -', 'less']) {
      expect([cmd, auditorAllowsCommand(cmd)]).toEqual([cmd, false]);
    }
    for (const cmd of ['cat /etc/hosts', 'cat -n /etc/hosts', 'head -n 20 /var/log/x', 'head -20 x', 'tail -n50 x', 'tail -- x']) {
      expect([cmd, auditorAllowsCommand(cmd)]).toEqual([cmd, true]);
    }
    // As a pipe stage they read the pipe.
    expect(auditorAllowsCommand('show log messages | tail -n 20')).toBe(true);
  });

  it('skips the value of a long option or BSD tail -b, so it is not taken for a file', () => {
    for (const cmd of ['head --lines 5', 'tail --lines 3', 'head --bytes 100', 'head --lin 5', 'tail -b 5', 'tail -qn 5', 'tail --sleep-interval 2']) {
      expect([cmd, auditorAllowsCommand(cmd)]).toEqual([cmd, false]);
    }
    for (const cmd of ['head --lines 5 /var/log/x', 'head --lines=5 /var/log/x', 'tail -b 5 x', 'head --quiet x', 'tail -qn 5 x']) {
      expect([cmd, auditorAllowsCommand(cmd)]).toEqual([cmd, true]);
    }
  });

  it('refuses files that wait on the keyboard or never end', () => {
    for (const cmd of [
      'cat /dev/stdin',
      'cat /dev/tty',
      'cat /dev/fd/0',
      'cat /proc/self/fd/0',
      'cat /dev/zero',
      'head -n 5 /dev/random',
      'tail -n 5 /dev/urandom',
      'cat /etc/hosts /dev/stdin',
      'cat "/dev/zero"',
      'cat /d\\ev/zero',
      'cat //dev/./zero',
      'cat /tmp/../dev/zero',
      'cat /proc/kmsg',
      'cat /d?v/zero',
      'cat $Z',
      'cat -- /dev/stdin',
      'show log | tail /dev/zero',
    ]) {
      expect([cmd, auditorAllowsCommand(cmd)]).toEqual([cmd, false]);
    }
    expect(auditorAllowsCommand('cat /dev/null')).toBe(true);
    expect(auditorAllowsCommand('cat /var/log/*.log')).toBe(true);
    expect(auditorAllowsCommand('cat /proc/cpuinfo')).toBe(true);
  });

  it('refuses tail +N with no file and paths that climb with ..', () => {
    for (const cmd of [
      'tail +2',
      'tail -q +2',
      'cat /proc/self/../self/fd/0',
      'cat /proc/1/../self/fd/0',
      'cat /proc/1/../kmsg',
      'show x | grep y /proc/self/../self/fd/1',
      'head -n 5 ../../dev/zero',
    ]) {
      expect([cmd, auditorAllowsCommand(cmd)]).toEqual([cmd, false]);
    }
    // tail +N with a file reads the file from line N; a grep pattern of .. is not a path.
    for (const cmd of ['tail +2 /var/log/x', 'show log | grep ..', 'cat /etc/hosts']) {
      expect([cmd, auditorAllowsCommand(cmd)]).toEqual([cmd, true]);
    }
  });

  it('refuses pings that go on for hours, and ping.exe without a count', () => {
    for (const cmd of [
      'ping -c 999999999 8.8.8.8',
      'ping 8.8.8.8 count 100000000',
      'ping -c101 8.8.8.8',
      'ping -c 2 -i 86400 8.8.8.8',
      'ping 10.0.0.1 count 5 interval 3600',
      'ping -c 2 -w 999999 8.8.8.8',
      'ping 10.0.0.1 count 5 wait 86400',
      'ping.exe -t 8.8.8.8',
      'PING.EXE 8.8.8.8',
      'ping -n 4 -t 8.8.8.8',
      'ping /n 4 /t 8.8.8.8',
      'ping -c 4 -c 0 8.8.8.8',
    ]) {
      expect([cmd, auditorAllowsCommand(cmd)]).toEqual([cmd, false]);
    }
    for (const cmd of [
      'ping -c 100 8.8.8.8',
      'ping -c 5 -i 0.2 8.8.8.8',
      'ping -c 3 -W 2 8.8.8.8',
      'ping.exe -n 4 -w 1000 8.8.8.8',
      'ping /n 4 8.8.8.8',
      'ping 10.0.0.1 count 5 wait 2 rapid',
    ]) {
      expect([cmd, auditorAllowsCommand(cmd)]).toEqual([cmd, true]);
    }
  });

  it('refuses sh when it runs a shell rather than meaning show', () => {
    for (const cmd of ['sh -c "id"', 'sh script.sh', 'sh /tmp/x', 'do sh -c id']) {
      expect([cmd, auditorAllowsCommand(cmd)]).toEqual([cmd, false]);
    }
    expect(auditorAllowsCommand('sh ip route')).toBe(true);
    expect(auditorAllowsCommand('sh run | inc vlan')).toBe(true);
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
