// Casper's tool labels (mcpLabels.ts, a synced copy) on the names GreenCLI's old
// aiMcpLooksWrite judged, plus the names it let through without asking.
import { describe, expect, it } from 'vitest';
import { strictest, toolLabel, SAFETY_RANK, type CapabilitySafety } from './mcpLabels';

const label = (name: string, annotations?: { readOnlyHint?: boolean; destructiveHint?: boolean }) =>
  toolLabel({ name, annotations });

describe('toolLabel', () => {
  it('judges write-looking names as at least write, with no annotations', () => {
    const cases: Array<[string, CapabilitySafety]> = [
      ['delete_device', 'destructive'],
      ['set_config', 'write'],
      ['reboot_ap', 'destructive'],
      ['create_site', 'write'],
      ['apply_template', 'write'],
      ['mcp_write_config', 'write'],
    ];
    for (const [name, expected] of cases) {
      expect(label(name), name).toBe(expected);
      expect(SAFETY_RANK[label(name)], name).toBeGreaterThanOrEqual(SAFETY_RANK.write);
    }
  });

  it('only lets a read-looking name read when the server says so', () => {
    for (const name of ['get_device', 'list_sites', 'read_config', 'show_status', 'search_clients']) {
      expect(label(name), name).toBe('external-action');
      expect(label(name, { readOnlyHint: true }), name).toBe('read');
    }
  });

  it("doesn't trust readOnlyHint on Casper's tricky names", () => {
    expect(label('get_and_delete_site', { readOnlyHint: true })).toBe('destructive');
    expect(label('bounce_interface', { readOnlyHint: true })).toBe('destructive');
    expect(label('invoke_tool', { readOnlyHint: true })).toBe('destructive');
    expect(label('load_and_commit_config', { readOnlyHint: true })).toBe('write');
  });

  it('catches the names the old check let through', () => {
    expect(label('bounce_port')).toBe('destructive');
    expect(label('execute_junos_command')).toBe('exec');
    expect(label('execute_junos_command', { readOnlyHint: true })).toBe('exec');
  });

  it('honours destructiveHint and _meta diagnostic', () => {
    expect(label('get_device', { readOnlyHint: true, destructiveHint: true })).toBe('destructive');
    expect(toolLabel({ name: 'probe_link', _meta: { 'casper/safety': 'diagnostic' } })).toBe('diagnostic');
    // _meta can't make a tool read.
    expect(toolLabel({ name: 'probe_link', _meta: { 'casper/safety': 'read' } })).toBe('external-action');
  });

  it('strictest picks the strictest label', () => {
    expect(strictest('read', 'exec', 'write')).toBe('exec');
    expect(strictest()).toBe('read');
  });
});
