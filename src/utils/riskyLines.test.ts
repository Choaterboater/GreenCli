import { describe, expect, it } from 'vitest';
import { classifyLine, commandIsDangerous, dangerReason } from './riskyLines';
import { aiIsWriteCommand } from './aiGating';
import { isRiskyCommand } from './commandRisk';

// One verdict per line, shared by the AI gate, multi-device sends and the Config Editor.
const kind = (line: string) => classifyLine(line).kind;

describe('riskyLines: one verdict for every check', () => {
  it('no shutdown brings a port up: a change, not dangerous', () => {
    expect(kind('no shutdown')).toBe('change');
    expect(isRiskyCommand('no shutdown')).toBe(true);
    expect(dangerReason('no shutdown')).toBeUndefined();
  });

  it('a peer or protocol shutdown anywhere in the line is dangerous', () => {
    expect(kind('neighbor 10.0.0.2 shutdown')).toBe('dangerous');
    expect(kind('ip ospf shutdown')).toBe('dangerous');
    expect(isRiskyCommand('neighbor 10.0.0.2 shutdown')).toBe(true);
  });

  it('free text is never a command: a description that says reload is a plain config line', () => {
    expect(kind('description Reload test port')).toBe('config');
    expect(isRiskyCommand('description Reload test port')).toBe(false);
    expect(commandIsDangerous('description Reload test port')).toBe(false);
  });

  it('saving is a change, not dangerous', () => {
    for (const line of ['write memory', 'copy running-config startup-config']) {
      expect(kind(line)).toBe('change');
      expect(commandIsDangerous(line)).toBe(false);
    }
  });

  it('commit is a change; rollback, install, upgrade and clear are dangerous', () => {
    expect(kind('commit')).toBe('change');
    expect(kind('rollback 1')).toBe('dangerous');
    expect(kind('rollback 0')).toBe('change'); // only throws away the uncommitted edits
    expect(kind('install')).toBe('dangerous');
    expect(kind('request system software add /var/tmp/junos.tgz')).toBe('dangerous');
    expect(kind('upgrade')).toBe('dangerous');
    expect(kind('clear ip bgp *')).toBe('dangerous');
    expect(kind('clear counters')).toBe('dangerous');
  });

  it('reload cancel and boot set-default are changes', () => {
    expect(kind('reload cancel')).toBe('change');
    expect(kind('boot set-default flash primary')).toBe('change');
  });

  it('Junos disable, deactivate and load override are dangerous', () => {
    expect(kind('set interfaces ge-0/0/0 disable')).toBe('dangerous');
    expect(kind('deactivate interfaces ge-0/0/0')).toBe('dangerous');
    expect(kind('load override terminal')).toBe('dangerous');
    expect(isRiskyCommand('set interfaces ge-0/0/0 disable')).toBe(true);
  });

  it('Junos delete of interfaces or VLANs is dangerous', () => {
    expect(kind('delete interfaces ge-0/0/0')).toBe('dangerous');
    expect(kind('delete vlans users')).toBe('dangerous');
    expect(kind('delete system syslog')).toBe('change');
  });

  it('a read verb wins over a risky word in its filter', () => {
    expect(kind('show running-config | include reload')).toBe('read');
    expect(aiIsWriteCommand('show running-config | include reload')).toBe(false);
    // A file-writing pipe is never a read.
    expect(aiIsWriteCommand('show log messages | save /var/log/messages')).toBe(true);
    // Nor is a chain: the second command could be anything.
    expect(aiIsWriteCommand('cat /etc/hosts; reboot')).toBe(true);
    expect(aiIsWriteCommand('uptime && reboot')).toBe(true);
  });

  it('halt and power-off are dangerous, and the AI dialog says so', () => {
    expect(kind('halt')).toBe('dangerous');
    expect(kind('request system power-off')).toBe('dangerous');
    expect(commandIsDangerous('show version\nhalt')).toBe(true);
  });

  it('the AI gate still asks about anything it cannot tell is a read', () => {
    expect(aiIsWriteCommand('interface 1/1/1')).toBe(true);
    expect(kind('interface 1/1/1')).toBe('config');
    expect(isRiskyCommand('interface 1/1/1')).toBe(false);
  });
});

describe('review: the AI gate never lets a hidden second command or a non-filter pipe pass as a read', () => {
  it('asks for every chain, background job, process substitution and shell', () => {
    for (const cmd of [
      'ping -c1 x & reboot', 'dir & format c: /q', 'cat /etc/hosts | xargs reboot', 'echo y | sudo reboot',
      'head x | delete', 'ping 1.1.1.1 | install', 'get system | reload', 'cat <(reboot)', 'sh -c "reboot"',
      'sh install.sh', 'show version; reload', 'show reload',
    ]) expect({ cmd, write: aiIsWriteCommand(cmd) }).toEqual({ cmd, write: true });
  });

  it('keeps real reads with filters as reads', () => {
    for (const cmd of [
      'show running-config | include reload', 'sh run | i shutdown', 'show interfaces | match down | count',
      'show log messages | last 20', 'cat /var/log/syslog | grep error', 'display current-configuration | include vlan',
    ]) expect({ cmd, write: aiIsWriteCommand(cmd) }).toEqual({ cmd, write: false });
  });

  it('a read with a risky word in its filter is a read for every check', () => {
    for (const line of ['show interface | include shutdown', 'show log | include zeroize', 'show run | include clear']) {
      expect(kind(line)).toBe('read');
      expect(isRiskyCommand(line)).toBe(false);
    }
  });
});

describe('review: wipes and reboots keep their danger styling', () => {
  it('flags format, filesystem deletes, factory resets and shell reboots', () => {
    for (const cmd of [
      'format flash:', 'delete flash:vlan.dat', 'delete /force nvram:startup-config', 'factory-reset', 'factory-default',
      'sudo reboot', 'systemctl reboot', 'show ver; reload',
    ]) expect({ cmd, danger: commandIsDangerous(cmd) }).toEqual({ cmd, danger: true });
  });

  it('does not flag clearing the screen or the Linux install tool', () => {
    expect(kind('clear')).not.toBe('dangerous');
    expect(kind('clear screen')).not.toBe('dangerous');
    expect(kind('install -m 644 a b')).not.toBe('dangerous');
    expect(kind('clear counters')).toBe('dangerous');
  });
});
