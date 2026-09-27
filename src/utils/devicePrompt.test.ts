import { describe, it, expect } from 'vitest';
import { detectDevicePrompt, parseDevicePrompt, trailingLine } from './devicePrompt';

const exec = (host: string) => ({ host, configMode: false });
const config = (host: string) => ({ host, configMode: true });

describe('parseDevicePrompt — AOS-CX', () => {
  it('reads exec and operator prompts', () => {
    expect(parseDevicePrompt('core-sw-01# ')).toEqual(exec('core-sw-01'));
    expect(parseDevicePrompt('core-sw-01> ')).toEqual(exec('core-sw-01'));
    expect(parseDevicePrompt('8325-A#')).toEqual(exec('8325-A'));
  });

  it('reads config mode and its sub-contexts', () => {
    expect(parseDevicePrompt('core-sw-01(config)# ')).toEqual(config('core-sw-01'));
    expect(parseDevicePrompt('core-sw-01(config-if)# ')).toEqual(config('core-sw-01'));
    expect(parseDevicePrompt('core-sw-01(config-vlan-10)# ')).toEqual(config('core-sw-01'));
    expect(parseDevicePrompt('8325-A(config-if-vlan)#')).toEqual(config('8325-A'));
    expect(parseDevicePrompt('agg1(config-router-ospf-1)# ')).toEqual(config('agg1'));
  });
});

describe('parseDevicePrompt — AOS-S', () => {
  it('reads manager mode', () => {
    expect(parseDevicePrompt('Aruba-2930F-24G-4SFPP# ')).toEqual(exec('Aruba-2930F-24G-4SFPP'));
    expect(parseDevicePrompt('HP-2920-24G> ')).toEqual(exec('HP-2920-24G'));
  });

  it('treats every context — not just (config) — as config mode', () => {
    expect(parseDevicePrompt('Aruba-2930F-24G-4SFPP(config)# ')).toEqual(config('Aruba-2930F-24G-4SFPP'));
    expect(parseDevicePrompt('Aruba-2930F(vlan-10)# ')).toEqual(config('Aruba-2930F'));
    expect(parseDevicePrompt('HP-2920-24G(eth-1/1)# ')).toEqual(config('HP-2920-24G'));
  });
});

describe('parseDevicePrompt — AOS-8 controllers', () => {
  it('reads enable and user mode', () => {
    expect(parseDevicePrompt('(Aruba7030) #')).toEqual(exec('Aruba7030'));
    expect(parseDevicePrompt('(Aruba7030) >')).toEqual(exec('Aruba7030'));
    expect(parseDevicePrompt('(ArubaMM) [mynode] #')).toEqual(exec('ArubaMM'));
    expect(parseDevicePrompt('(MD-01) *[MDC] #')).toEqual(exec('MD-01'));
  });

  it('reads config mode, pending-change markers and profile contexts', () => {
    expect(parseDevicePrompt('(Aruba7030) (config) #')).toEqual(config('Aruba7030'));
    expect(parseDevicePrompt('(ArubaMM) [mynode] (config) #')).toEqual(config('ArubaMM'));
    expect(parseDevicePrompt('(ArubaMM) ^[mynode] (config) #')).toEqual(config('ArubaMM'));
    expect(parseDevicePrompt('(MD-01) [md] (config-submode)#')).toEqual(config('MD-01'));
    expect(parseDevicePrompt('(Aruba7210) (Virtual AP profile "guest") #')).toEqual(config('Aruba7210'));
  });
});

describe('parseDevicePrompt — Instant APs', () => {
  it('reads exec and config mode', () => {
    expect(parseDevicePrompt('IAP-515# ')).toEqual(exec('IAP-515'));
    expect(parseDevicePrompt('IAP-515 (config) # ')).toEqual(config('IAP-515'));
    expect(parseDevicePrompt('IAP-515 (SSID Profile "corp") # ')).toEqual(config('IAP-515'));
  });
});

describe('parseDevicePrompt — Junos', () => {
  it('reads operational and configuration mode', () => {
    expect(parseDevicePrompt('admin@ex4300-48p> ')).toEqual(exec('ex4300-48p'));
    expect(parseDevicePrompt('admin@ex4300-48p# ')).toEqual(config('ex4300-48p'));
    expect(parseDevicePrompt('root@srx-01.lab> ')).toEqual(exec('srx-01.lab'));
    expect(parseDevicePrompt('{master:0}admin@ex4300> ')).toEqual(exec('ex4300'));
  });

  it('takes the host after the last @ (TACACS logins can contain one)', () => {
    expect(parseDevicePrompt('jdoe@corp.example@mx960-re0> ')).toEqual(exec('mx960-re0'));
  });

  it("ignores the Junos shell (it's not the CLI)", () => {
    expect(parseDevicePrompt('root@ex4300:RE:0% ')).toBeNull();
    expect(parseDevicePrompt('root@ex4300:~ # ')).toBeNull();
  });
});

describe('parseDevicePrompt — not a prompt', () => {
  it.each([
    '',
    'Password:',
    'login: ',
    'admin@linux-box:~$ ',
    'root@linux-box:~# ',
    '[admin@linux-box ~]$ ',
    'core-sw-01# show vlan',
    '-- MORE --, next page: Space, next line: Enter, quit: Control-C',
    'Do you want to save the current configuration (y/n)?',
    'bash-5.1#',
    'sh-3.2# ',
    '<rpc-reply>',
    'x'.repeat(200) + '#',
  ])('%j', (line) => {
    expect(parseDevicePrompt(line)).toBeNull();
  });
});

describe('trailingLine', () => {
  it('takes the text after the last newline', () => {
    expect(trailingLine('show clock\r\n12:00\r\ncore-sw-01# ')).toBe('core-sw-01# ');
    expect(trailingLine('core-sw-01# show clock\r\n')).toBe('');
  });

  it('drops escape codes', () => {
    expect(trailingLine('\r\n\x1b[1;32mcore-sw-01(config)#\x1b[0m \x1b[?2004h')).toBe('core-sw-01(config)# ');
    expect(trailingLine('\x1b]0;core-sw-01\x07core-sw-01# ')).toBe('core-sw-01# ');
  });

  it('applies carriage-return redraws and backspaces', () => {
    expect(trailingLine('core-sw-01# con\r\x1b[Kcore-sw-01# ')).toBe('core-sw-01# ');
    expect(trailingLine('core-sw-01# s\b \b')).toBe('core-sw-01# ');
  });
});

describe('detectDevicePrompt', () => {
  it('reads the prompt the device is waiting at', () => {
    expect(detectDevicePrompt('Entering config mode\r\ncore-sw-01(config)# ')).toEqual(config('core-sw-01'));
    expect(detectDevicePrompt('\r\n[edit interfaces ge-0/0/0]\r\nadmin@ex4300# ')).toEqual(config('ex4300'));
    expect(detectDevicePrompt('\r\n{master:0}\r\nadmin@ex4300> ')).toEqual(exec('ex4300'));
    expect(detectDevicePrompt('\r\n(ArubaMM) [mynode] (config) #')).toEqual(config('ArubaMM'));
  });

  it('says nothing while output is still coming or a command is being typed', () => {
    expect(detectDevicePrompt('core-sw-01(config)# interface 1/1/1\r\n')).toBeNull();
    expect(detectDevicePrompt('core-sw-01(config)# inter')).toBeNull();
    expect(detectDevicePrompt('VLAN  Name\r\n-- MORE --')).toBeNull();
  });
});
