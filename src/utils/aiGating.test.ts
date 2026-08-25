import { describe, it, expect } from 'vitest';
import { aiIsWriteCommand, aiMcpLooksWrite } from './aiGating';

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
});

describe('aiMcpLooksWrite', () => {
  it('flags write-looking tool names', () => {
    expect(aiMcpLooksWrite('delete_device')).toBe(true);
    expect(aiMcpLooksWrite('set_config')).toBe(true);
    expect(aiMcpLooksWrite('reboot_ap')).toBe(true);
    expect(aiMcpLooksWrite('create_site')).toBe(true);
    expect(aiMcpLooksWrite('apply_template')).toBe(true);
    expect(aiMcpLooksWrite('mcp_write_config')).toBe(true);
  });

  it('passes read-looking tool names', () => {
    expect(aiMcpLooksWrite('get_device')).toBe(false);
    expect(aiMcpLooksWrite('list_sites')).toBe(false);
    expect(aiMcpLooksWrite('read_config')).toBe(false);
    expect(aiMcpLooksWrite('show_status')).toBe(false);
    expect(aiMcpLooksWrite('search_clients')).toBe(false);
  });
});
