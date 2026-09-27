import { describe, it, expect, vi } from 'vitest';

vi.mock('@tauri-apps/api/event', () => ({ listen: vi.fn() }));
vi.mock('@tauri-apps/api/tauri', () => ({ invoke: vi.fn() }));

import {
  isDangerousLine,
  prepareSendLines,
  hasDeviceError,
  looksLikePrompt,
  runConfigSend,
  describeSendBaseline,
  deviceKey,
  findEcho,
  type SendIO,
} from './configSafety';
import type { ConnectionConfig } from '../types';

describe('isDangerousLine', () => {
  it('flags shutdown, but not its "no" negation', () => {
    expect(isDangerousLine('shutdown')).toBe(true);
    expect(isDangerousLine('  shutdown')).toBe(true);
    expect(isDangerousLine('neighbor 10.0.0.2 shutdown')).toBe(true);
    expect(isDangerousLine('ip ospf shutdown')).toBe(true);
    expect(isDangerousLine('no shutdown')).toBe(false);
    expect(isDangerousLine('  no shutdown')).toBe(false);
    expect(isDangerousLine('no ip ospf shutdown')).toBe(false);
    expect(isDangerousLine('NO SHUTDOWN')).toBe(false);
  });

  it('ignores the dangerous words inside names, descriptions, and quoted text', () => {
    expect(isDangerousLine('description shutdown after cutover')).toBe(false);
    expect(isDangerousLine('description Reload test port')).toBe(false);
    expect(isDangerousLine('set interfaces ge-0/0/0 description "reboot me"')).toBe(false);
    expect(isDangerousLine('name erase-later')).toBe(false);
    expect(isDangerousLine('vlan 10 name shutdown-vlan')).toBe(false);
    expect(isDangerousLine('interface lag 1 reload-delay 10')).toBe(false);
  });

  it('flags erase / reload / reboot but not reload cancel', () => {
    expect(isDangerousLine('erase startup-config')).toBe(true);
    expect(isDangerousLine('write erase')).toBe(true);
    expect(isDangerousLine('do reload')).toBe(true);
    expect(isDangerousLine('reload at 23:00')).toBe(true);
    expect(isDangerousLine('reload cancel')).toBe(false);
    expect(isDangerousLine('request system reboot')).toBe(true);
    expect(isDangerousLine('request system zeroize')).toBe(true);
    expect(isDangerousLine('boot system primary')).toBe(true);
    expect(isDangerousLine('boot set-default flash primary')).toBe(false);
  });

  it('treats the normal save step as safe but overwriting config from elsewhere as risky', () => {
    expect(isDangerousLine('copy running-config startup-config')).toBe(false);
    expect(isDangerousLine('copy run start')).toBe(false);
    expect(isDangerousLine('write memory')).toBe(false);
    expect(isDangerousLine('commit')).toBe(false);
    expect(isDangerousLine('copy tftp://10.0.0.5/sw.cfg startup-config')).toBe(true);
    expect(isDangerousLine('copy startup-config running-config')).toBe(true);
    expect(isDangerousLine('copy checkpoint before-change running-config')).toBe(true);
  });

  it('handles Junos deletes precisely', () => {
    expect(isDangerousLine('delete')).toBe(true);
    expect(isDangerousLine('delete system')).toBe(true);
    expect(isDangerousLine('delete system services ssh')).toBe(true);
    expect(isDangerousLine('delete system login user bob')).toBe(true);
    expect(isDangerousLine('delete system syslog host 10.0.0.9')).toBe(false);
    expect(isDangerousLine('delete vlans GUEST')).toBe(false);
    expect(isDangerousLine('load override terminal')).toBe(true);
    expect(isDangerousLine('set interfaces ge-0/0/1 disable')).toBe(true);
    expect(isDangerousLine('set interfaces ge-0/0/1 description disable-me')).toBe(false);
  });

  it('flags removing interfaces, VLANs, and routing processes', () => {
    expect(isDangerousLine('no interface lag 1')).toBe(true);
    expect(isDangerousLine('no vlan 20')).toBe(true);
    expect(isDangerousLine('no vlan access 20')).toBe(false);
    expect(isDangerousLine('no router bgp 65001')).toBe(true);
    expect(isDangerousLine('vlan access 20')).toBe(false);
  });
});

describe('prepareSendLines', () => {
  it('drops comments and keeps editor line numbers', () => {
    const lines = prepareSendLines(
      '! header\nvlan 10\n/* multi\nline */\n  name MGMT\n\n# note\nset a /* inline */ b\n/* unterminated\nexit'
    );
    expect(lines).toEqual([
      { text: 'vlan 10', lineNumber: 2 },
      { text: 'name MGMT', lineNumber: 5 },
      { text: 'set a  b', lineNumber: 8 },
      { text: 'exit', lineNumber: 10 },
    ]);
  });
});

describe('device responses', () => {
  it('recognizes vendor error text', () => {
    expect(hasDeviceError('Invalid input: allowd')).toBe(true);
    expect(hasDeviceError('% Invalid input detected at marker.')).toBe(true);
    expect(hasDeviceError('                 ^\nsyntax error.')).toBe(true);
    expect(hasDeviceError('error: configuration check-out failed')).toBe(true);
    expect(hasDeviceError('unknown command.')).toBe(true);
    expect(hasDeviceError('Incomplete command.')).toBe(true);
    expect(hasDeviceError('Copying configuration: [Success]')).toBe(false);
    expect(hasDeviceError('Input errors: 0, CRC error: 0')).toBe(false);
  });

  it('recognizes prompts at the end of the response', () => {
    expect(looksLikePrompt('vlan 10\nsw1(config-vlan-10)# ')).toBe(true);
    expect(looksLikePrompt('\n[edit]\nadmin@ex4300# ')).toBe(true);
    expect(looksLikePrompt('show ver\nHP-2920> ')).toBe(true);
    expect(looksLikePrompt('vlan 10')).toBe(false);
    expect(looksLikePrompt('vlan 10\nstill printing')).toBe(false);
  });
});

/**
 * A fake device on a fake clock: echoes each line and answers from `respond`.
 * Like a real CLI it handles input in order, so a slow answer (`delay`) also
 * holds back the answers to everything typed after it.
 */
function fakeDevice(
  respond: (line: string, n: number) => string,
  delay: (line: string) => number = () => 0
) {
  let out = '';
  let clock = 0;
  let busyUntil = 0;
  const sent: string[] = [];
  const pending: { at: number; text: string }[] = [];
  let cancel = false;
  const io: SendIO = {
    send: async (data) => {
      const line = data.replace(/\r$/, '');
      sent.push(line);
      const reply = `${line}\r\n${respond(line, sent.length)}`;
      busyUntil = Math.max(busyUntil, clock) + delay(line);
      pending.push({ at: busyUntil, text: reply });
    },
    output: () => {
      while (pending.length && pending[0].at <= clock) out += pending.shift()!.text;
      return out;
    },
    sleep: async (ms) => {
      clock += ms;
    },
    cancelled: () => cancel,
    now: () => clock,
  };
  return { io, sent, cancelNow: () => (cancel = true) };
}

const L = (...texts: string[]) => texts.map((text, i) => ({ text, lineNumber: i + 1 }));

describe('runConfigSend', () => {
  it('sends everything when the device answers each line with a prompt', async () => {
    const dev = fakeDevice(() => 'sw1(config)# ');
    const result = await runConfigSend(L('vlan 10', 'name MGMT', 'exit'), dev.io);
    expect(result).toEqual({ kind: 'done', sent: 3 });
    expect(dev.sent).toEqual(['vlan 10', 'name MGMT', 'exit']);
  });

  it('stops at the first device error and reports its text', async () => {
    const dev = fakeDevice((line) =>
      line.includes('allowd') ? 'Invalid input: allowd\r\nsw1(config-if)# ' : 'sw1(config-if)# '
    );
    const result = await runConfigSend(
      L('interface 1/1/1', 'vlan trunk allowd 10', 'no shutdown'),
      dev.io
    );
    expect(result).toEqual({
      kind: 'device-error',
      sent: 2,
      failedIndex: 1,
      deviceText: 'Invalid input: allowd',
    });
    expect(dev.sent).not.toContain('no shutdown');
  });

  it('captures a multi-line Junos error', async () => {
    const dev = fakeDevice((line) =>
      line.startsWith('set foo')
        ? '        ^\r\nsyntax error.\r\n\r\n[edit]\r\nadmin@ex# '
        : '\r\n[edit]\r\nadmin@ex# '
    );
    const result = await runConfigSend(L('set vlans V10 vlan-id 10', 'set foo bar', 'commit'), dev.io);
    expect(result.kind).toBe('device-error');
    if (result.kind !== 'device-error') return;
    expect(result.failedIndex).toBe(1);
    expect(result.deviceText).toContain('syntax error.');
    expect(dev.sent).toEqual(['set vlans V10 vlan-id 10', 'set foo bar']);
  });

  it('does not mistake error-like words in the echoed command for an error', async () => {
    const dev = fakeDevice(() => 'sw1(config-if)# ');
    const result = await runConfigSend(L('description error: fix later'), dev.io);
    expect(result).toEqual({ kind: 'done', sent: 1 });
  });

  it('keeps going when "configure terminal" fails because we are already in config mode', async () => {
    const dev = fakeDevice((line) =>
      line === 'configure terminal' ? 'Invalid input: configure\r\nsw1(config)# ' : 'sw1(config)# '
    );
    const result = await runConfigSend(L('configure terminal', 'vlan 10'), dev.io);
    expect(result).toEqual({ kind: 'done', sent: 2 });
  });

  it('stops when the device asks a question', async () => {
    const dev = fakeDevice((line) =>
      line === 'no vlan 20' ? 'This will remove the VLAN. Continue (y/n)? ' : 'sw1(config)# '
    );
    const result = await runConfigSend(L('no vlan 20', 'vlan 30'), dev.io);
    expect(result.kind).toBe('question');
    expect(dev.sent).toEqual(['no vlan 20']);
  });

  it('waits for a slow device instead of sending ahead of it', async () => {
    // Every answer takes 2s — longer than the no-echo give-up on line 1.
    const dev = fakeDevice(
      (line) => (line === 'bad' ? 'Invalid input: bad\r\nsw1# ' : 'sw1# '),
      () => 2000
    );
    const result = await runConfigSend(L('good', 'bad', 'next'), dev.io);
    expect(result).toMatchObject({ kind: 'device-error', failedIndex: 1, sent: 2 });
    expect(dev.sent).toEqual(['good', 'bad']);
  });

  it('pins a late error on the line that caused it', async () => {
    // "bad" takes longer than the per-line wait, so "next" goes out before
    // its error shows up.
    const dev = fakeDevice(
      (line) => (line === 'bad' ? 'Invalid input: bad\r\nsw1# ' : 'sw1# '),
      (line) => (line === 'bad' ? 6000 : 0)
    );
    const result = await runConfigSend(L('good', 'bad', 'next', 'never'), dev.io);
    expect(result).toMatchObject({
      kind: 'device-error',
      failedIndex: 1,
      sent: 3,
      deviceText: 'Invalid input: bad',
    });
    expect(dev.sent).not.toContain('never');
  });

  it('matches the echo of a long line the device wrapped at the margin', async () => {
    const long = 'set class-of-service classifiers dscp ROCE forwarding-class NO-LOSS loss-priority low code-points 011010';
    expect(findEcho(`x# ${long.slice(0, 60)} \r${long.slice(60)}\r\n`, long, 0)).toEqual({ at: 3, end: 3 + long.length + 2 });
    expect(findEcho('vlan 1', 'vlan 10', 0)).toBeNull();

    let out = '';
    const io: SendIO = {
      send: async (data) => {
        const line = data.replace(/\r$/, '');
        const wrapped = line.length > 40 ? `${line.slice(0, 40)}\r\n${line.slice(40)}` : line;
        out += `${wrapped}\r\n${line === long ? '        ^\r\nsyntax error.\r\n' : ''}admin@ex# `;
      },
      output: () => out,
      sleep: async () => {},
      cancelled: () => false,
      now: (() => {
        let t = 0;
        return () => (t += 25);
      })(),
    };
    const result = await runConfigSend(L('set vlans V10 vlan-id 10', long, 'set vlans V20 vlan-id 20'), io);
    expect(result).toMatchObject({ kind: 'device-error', failedIndex: 1, sent: 2 });
  });

  it('moves on when the device never answers', async () => {
    const dev = fakeDevice(() => '');
    const io = { ...dev.io, output: () => '' };
    const result = await runConfigSend(L('a', 'b'), io);
    expect(result).toEqual({ kind: 'done', sent: 2 });
  });

  it('stops when cancelled', async () => {
    const dev = fakeDevice((_line, n) => {
      if (n === 2) dev.cancelNow();
      return 'sw1# ';
    });
    const result = await runConfigSend(L('a', 'b', 'c'), dev.io);
    expect(result).toEqual({ kind: 'cancelled', sent: 2 });
  });

  it('reports a failed send', async () => {
    const dev = fakeDevice(() => 'sw1# ');
    const io = { ...dev.io, send: async () => Promise.reject(new Error('gone')) };
    const result = await runConfigSend(L('a'), io);
    expect(result.kind).toBe('send-failed');
  });
});

describe('send baseline', () => {
  const cfg = (host: string): ConnectionConfig =>
    ({ id: host, name: host, protocol: 'ssh', host, port: 22 }) as ConnectionConfig;

  it('keys baselines by device', () => {
    expect(deviceKey(cfg('10.0.0.1'))).toBe(deviceKey({ ...cfg('10.0.0.1'), id: 'other-tab' }));
    expect(deviceKey(cfg('10.0.0.1'))).not.toBe(deviceKey(cfg('10.0.0.2')));
  });

  it('diffs only against the target device and calls out a baseline from another one', () => {
    const base = { text: 'vlan 10\nvlan 20', label: 'core-sw1', pulledAt: Date.now(), truncated: false };
    expect(describeSendBaseline('vlan 10\nvlan 30', 'core-sw1', base, base)).toMatch(
      /pulled from core-sw1 .*\+1 \/ -1/s
    );
    const other = describeSendBaseline('vlan 10', 'edge-sw9', undefined, base);
    expect(other).toContain('No running-config pulled from edge-sw9');
    expect(other).toContain('last pull was from core-sw1');
    expect(describeSendBaseline('vlan 10', 'edge-sw9', undefined, undefined)).toContain('No running-config pulled');
  });
});
