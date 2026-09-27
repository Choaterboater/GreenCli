import { describe, it, expect } from 'vitest';
import {
  defaultBaudRate,
  hostIdentity,
  hostSummary,
  parseHostSpec,
  rankSerialPorts,
  splitNewHosts,
} from './hosts';

describe('parseHostSpec', () => {
  it('splits user@host:port', () => {
    expect(parseHostSpec('admin@10.0.0.1:2222')).toEqual({ host: '10.0.0.1', user: 'admin', port: 2222 });
  });

  it('accepts host:port and a plain host', () => {
    expect(parseHostSpec('core-sw-01:830')).toEqual({ host: 'core-sw-01', user: undefined, port: 830 });
    expect(parseHostSpec('  core-sw-01  ')).toEqual({ host: 'core-sw-01', user: undefined, port: undefined });
    expect(parseHostSpec('admin@core-sw-01')).toEqual({ host: 'core-sw-01', user: 'admin', port: undefined });
  });

  it('accepts bracketed IPv6 with or without a port', () => {
    expect(parseHostSpec('[2001:db8::1]:22')).toEqual({ host: '2001:db8::1', user: undefined, port: 22 });
    expect(parseHostSpec('netops@[fe80::1]')).toEqual({ host: 'fe80::1', user: 'netops', port: undefined });
  });

  it('never takes a port off a bare IPv6 address', () => {
    expect(parseHostSpec('2001:db8::1')).toEqual({ host: '2001:db8::1', user: undefined, port: undefined });
    expect(parseHostSpec('admin@2001:db8::22')).toEqual({ host: '2001:db8::22', user: 'admin', port: undefined });
  });

  it('splits on the LAST @ (TACACS usernames can contain one)', () => {
    expect(parseHostSpec('jdoe@corp.example@10.1.1.1')).toEqual({
      host: '10.1.1.1',
      user: 'jdoe@corp.example',
      port: undefined,
    });
  });

  it('leaves an invalid port in the host so the typo is visible', () => {
    expect(parseHostSpec('10.0.0.1:99999')).toEqual({ host: '10.0.0.1:99999', user: undefined, port: undefined });
    expect(parseHostSpec('10.0.0.1:ssh')).toEqual({ host: '10.0.0.1:ssh', user: undefined, port: undefined });
  });

  it('treats an empty user as none', () => {
    expect(parseHostSpec('@10.0.0.1')).toEqual({ host: '10.0.0.1', user: undefined, port: undefined });
  });
});

describe('defaultBaudRate', () => {
  it('uses 115200 for AOS-CX and 9600 for everything else', () => {
    expect(defaultBaudRate('aruba-cx')).toBe(115200);
    expect(defaultBaudRate('aruba-aos-s')).toBe(9600);
    expect(defaultBaudRate('aruba-controller')).toBe(9600);
    expect(defaultBaudRate('juniper-junos')).toBe(9600);
    expect(defaultBaudRate('generic')).toBe(9600);
  });
});

describe('hostSummary', () => {
  it('shows user@host and only a non-default port', () => {
    expect(hostSummary({ protocol: 'ssh', host: '10.0.0.1', port: 22, username: 'admin' })).toBe('admin@10.0.0.1');
    expect(hostSummary({ protocol: 'ssh', host: '10.0.0.1', port: 2222 })).toBe('10.0.0.1:2222');
    expect(hostSummary({ protocol: 'telnet', host: 'sw1', port: 23 })).toBe('sw1');
  });

  it('brackets IPv6 only when a port follows', () => {
    expect(hostSummary({ protocol: 'ssh', host: '2001:db8::1', port: 22 })).toBe('2001:db8::1');
    expect(hostSummary({ protocol: 'ssh', host: '2001:db8::1', port: 830 })).toBe('[2001:db8::1]:830');
  });

  it('shows the serial port, and nothing for local shells', () => {
    expect(hostSummary({ protocol: 'serial', serialPort: 'COM3' })).toBe('COM3');
    expect(hostSummary({ protocol: 'local' })).toBe('');
  });
});

describe('splitNewHosts', () => {
  it('drops hosts already saved (same host, port and user; host case-insensitive)', () => {
    const existing = [{ host: 'Core-SW-01', port: 22, username: 'admin' }];
    const { fresh, duplicates } = splitNewHosts(
      [
        { name: 'a', host: 'core-sw-01', port: 22, username: 'admin' },
        { name: 'b', host: 'core-sw-01', port: 22, username: 'netops' },
        { name: 'c', host: 'core-sw-01', port: 2222, username: 'admin' },
      ],
      existing,
    );
    expect(fresh.map((h) => h.name)).toEqual(['b', 'c']);
    expect(duplicates.map((h) => h.name)).toEqual(['a']);
  });

  it('treats a missing port as 22 and drops repeats within the same batch', () => {
    const { fresh, duplicates } = splitNewHosts(
      [
        { name: 'a', host: 'sw1', port: 22 },
        { name: 'b', host: 'sw1' },
      ],
      [],
    );
    expect(fresh.map((h) => h.name)).toEqual(['a']);
    expect(duplicates.map((h) => h.name)).toEqual(['b']);
    expect(hostIdentity({ host: 'sw1' })).toBe(hostIdentity({ host: 'SW1', port: 22 }));
  });
});

describe('rankSerialPorts', () => {
  it('puts the USB console cable first on macOS and hides tty.* twins / Bluetooth', () => {
    const { ordered, preferred } = rankSerialPorts([
      '/dev/cu.Bluetooth-Incoming-Port',
      '/dev/tty.usbserial-A10K',
      '/dev/cu.usbserial-A10K',
      '/dev/cu.debug-console',
    ]);
    expect(ordered[0]).toBe('/dev/cu.usbserial-A10K');
    expect(preferred).toBe('/dev/cu.usbserial-A10K');
  });

  it('preselects a lone COM port on Windows, sorting COM10 after COM3', () => {
    expect(rankSerialPorts(['COM3'])).toEqual({ ordered: ['COM3'], preferred: 'COM3' });
    expect(rankSerialPorts(['COM10', 'COM3'])).toEqual({ ordered: ['COM3', 'COM10'], preferred: undefined });
  });

  it('does not guess between two console cables', () => {
    expect(rankSerialPorts(['/dev/ttyUSB1', '/dev/ttyUSB0', '/dev/ttyS0'])).toEqual({
      ordered: ['/dev/ttyUSB0', '/dev/ttyUSB1', '/dev/ttyS0'],
      preferred: undefined,
    });
  });

  it('handles no ports', () => {
    expect(rankSerialPorts([])).toEqual({ ordered: [], preferred: undefined });
  });
});
