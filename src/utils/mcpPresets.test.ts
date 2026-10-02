import { describe, expect, it } from 'vitest';
import { isPlainJunosShow, junosShow, presetNotes, presetTighten } from './mcpPresets';

describe('isPlainJunosShow', () => {
  it('accepts a show with safe pipes', () => {
    expect(isPlainJunosShow('show interfaces terse | match ge- | no-more')).toBe(true);
    expect(isPlainJunosShow('show version')).toBe(true);
    expect(isPlainJunosShow('show\tversion')).toBe(true);
  });

  it('refuses anything else', () => {
    const cases = [
      'show | save /tmp/x',
      'sh int',
      'show version; request system reboot',
      'show\nconfigure',
      `show${String.fromCodePoint(0x85)}x`,
      `show${String.fromCodePoint(0xfeff)}version`,
      'show\vversion',
      'show',
      'show Version',
      'request system reboot',
      `show ${'a'.repeat(510)}`,
      undefined,
      42,
    ];
    for (const command of cases) expect(isPlainJunosShow(command), JSON.stringify(command)).toBe(false);
  });

  it('allows exactly 512 characters', () => {
    expect(isPlainJunosShow(`show ${'a'.repeat(507)}`)).toBe(true);
    expect(isPlainJunosShow(`show ${'a'.repeat(508)}`)).toBe(false);
  });
});

describe('junosShow', () => {
  it('reads the command and commands shapes', () => {
    expect(junosShow('execute_junos_command', { command: 'show version' })).toBe('all-show');
    expect(junosShow('execute_junos_command_batch', { commands: ['show version', 'show chassis alarms'] })).toBe(
      'all-show'
    );
    expect(junosShow('execute_junos_command_batch', { commands: ['show version', 'configure'] })).toBe('not-show');
    expect(junosShow('execute_junos_command_batch', { commands: 'show version' })).toBe('not-show');
    expect(junosShow('execute_junos_command', {})).toBe('not-show');
    expect(junosShow('get_router_list', { command: 'show version' })).toBe('n/a');
  });
});

describe('presetTighten', () => {
  it('only raises labels', () => {
    expect(presetTighten('junos-mcp-server', 'load_and_commit_config', 'write')).toBe('destructive');
    expect(presetTighten('junos-mcp-server', 'execute_junos_command', 'read')).toBe('exec');
    expect(presetTighten('junos-mcp-server', 'execute_x', 'destructive')).toBe('destructive');
    expect(presetTighten('netmiko-mcp', 'send_config_set', 'read')).toBe('exec');
    expect(presetTighten('netmiko-mcp', 'get_config', 'read')).toBe('exec');
    expect(presetTighten('hpe-networking-mcp', 'invoke_tool', 'read')).toBe('destructive');
    expect(presetTighten(undefined, 'invoke_tool', 'read')).toBe('read');
  });

  it('adds the Junos commit notes', () => {
    expect(presetNotes('junos-mcp-server', 'load_and_commit_config')).toEqual([
      'load_and_commit_config commits right away. No preview and no auto-rollback',
    ]);
    expect(presetNotes('netbox', 'load_and_commit_config')).toEqual([]);
  });
});
