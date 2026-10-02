import { describe, expect, it } from 'vitest';
import {
  argsDepth,
  callLabel,
  decideMcpCall,
  effectiveLabel,
  readNamed,
  toolFingerprint,
  TOO_DEEP,
  type McpGateDecision,
} from './mcpGate';
import { buildPlan } from './mcpApproval';
import type { McpToolInfo } from './mcpTypes';

const READ_ONLY = { readOnlyHint: true };

function tool(name: string, extra: Partial<McpToolInfo> = {}): McpToolInfo {
  return { server: 'srv', name, description: '', inputSchema: { type: 'object' }, ...extra };
}

function decide(t: McpToolInfo, args: Record<string, unknown> = {}, allowedForSession = false): McpGateDecision {
  return decideMcpCall({ tool: t, args, allowedForSession, readOnlyAgent: false });
}

function asked(d: McpGateDecision) {
  if (d.kind !== 'ask') throw new Error(`expected ask, got ${JSON.stringify(d)}`);
  return d;
}

const junos = (name: string, showOptIn = false) => tool(name, { preset: 'junos-mcp-server', showOptIn });

describe('decideMcpCall', () => {
  it('runs a tool the server marks read-only', () => {
    expect(decide(tool('get_device', { annotations: READ_ONLY }))).toEqual({ kind: 'run', label: 'read', why: 'read' });
  });

  it('asks about an unmarked read-named tool, and offers the session', () => {
    const d = asked(decide(tool('get_device')));
    expect(d.choices).toEqual(['no', 'once', 'session']);
    expect(d.danger).toBe(false);
    expect(d.notes[0]).toBe("The server doesn't say this tool only reads, so it might change something");
    expect(decide(tool('get_device'), {}, true)).toEqual({ kind: 'run', label: 'external-action', why: 'session' });
  });

  it('never offers the session for a name that does not clearly read', () => {
    expect(asked(decide(tool('cycle_poe'))).choices).toEqual(['no', 'once']);
    // Even when the store says it was allowed.
    expect(asked(decide(tool('cycle_poe'), {}, true)).choices).toEqual(['no', 'once']);
  });

  it('asks with danger about a destructive name, whatever the server says', () => {
    const d = asked(decide(tool('bounce_port', { annotations: READ_ONLY }), {}, true));
    expect(d.choices).toEqual(['no', 'once']);
    expect(d.danger).toBe(true);
    expect(d.notes).toContain('This tool can delete, restart or disconnect things');
  });

  it('names the tool behind a router', () => {
    const d = asked(decide(tool('invoke_tool'), { name: 'port_bounce', arguments: { serial_number: 'SG1' } }));
    expect(d.choices).toEqual(['no', 'once']);
    expect(d.notes).toContain('Runs port_bounce through invoke_tool');
  });

  it('always asks about a router, even a read one', () => {
    const router = tool('invoke_read_tool', { annotations: READ_ONLY });
    const cycle = asked(decide(router, { name: 'cycle_port' }));
    expect(cycle.choices).toEqual(['no', 'once']);
    expect(cycle.label).toBe('external-action');
    const get = asked(decide(router, { name: 'get_device' }, true));
    expect(get.choices).toEqual(['no', 'once']);
    expect(get.label).toBe('read');
    expect(get.notes).toEqual(['Runs get_device through invoke_read_tool']);
  });

  it('describes batches and routers it cannot read', () => {
    const batch = asked(decide(tool('invoke_tools_batch'), { calls: [{ name: 'get_a' }, { name: 'get_b' }, { x: 1 }] }));
    expect(batch.notes).toContain("Runs 2 tools through invoke_tools_batch: get_a, get_b, and tools GreenCLI can't see");
    const unclear = asked(decide(tool('invoke_read_tool', { annotations: READ_ONLY }), { tool_id: 'x' }));
    expect(unclear.notes).toContain("Runs a tool GreenCLI can't see, through invoke_read_tool");
  });

  it('says what a write tool does', () => {
    const d = asked(decide(tool('set_ssid')));
    expect(d.notes).toContain('This tool can change settings');
    expect(d.danger).toBe(true);
  });

  it('asks when the AI set confirm on a read tool', () => {
    const d = asked(decide(tool('get_device', { annotations: READ_ONLY }), { confirm: true }));
    expect(d.choices).toEqual(['no', 'once']);
    expect(d.notes).toContain(
      "The AI set confirm=true. That skips the server's own check, so only your Yes lets it run"
    );
    const two = asked(decide(tool('get_device', { annotations: READ_ONLY }), { confirm: 'yes', opts: { force: 1 } }));
    expect(two.notes).toContain(
      "The AI set confirm=true and force=true. That skips the server's own check, so only your Yes lets it run"
    );
  });

  it('asks when the AI turned off a preview switch', () => {
    const d = asked(decide(tool('get_device', { annotations: READ_ONLY }), { dry_run: false }));
    expect(d.notes).toContain('The AI turned off dry_run, so this makes the change instead of only showing it');
  });

  it('refuses arguments nested deeper than the checks look', () => {
    let args: Record<string, unknown> = { confirm: true };
    for (let i = 0; i < 32; i++) args = { a: args };
    expect(argsDepth(args)).toBe(33);
    expect(decide(tool('get_device', { annotations: READ_ONLY }), args)).toEqual({ kind: 'refuse', text: TOO_DEEP });
    // 32 levels is still checked.
    let ok: Record<string, unknown> = { confirm: true };
    for (let i = 0; i < 31; i++) ok = { a: ok };
    expect(asked(decide(tool('get_device', { annotations: READ_ONLY }), ok)).choices).toEqual(['no', 'once']);
  });

  it('runs a Junos plain show only with the opt-in', () => {
    const args = { command: 'show version' };
    expect(decide(junos('execute_junos_command', true), args)).toEqual({
      kind: 'run',
      label: 'exec',
      why: 'junos-show',
    });
    const d = asked(decide(junos('execute_junos_command'), args));
    expect(d.choices).toEqual(['no', 'once']);
    expect(d.notes).toContain(
      'Plain show command. To run these without asking, turn on "Run plain show commands without asking" ' +
        'for this server in Settings → MCP Servers'
    );
  });

  it('still asks about Junos PFE commands, non-show commands and skipped checks', () => {
    expect(decide(junos('execute_junos_pfe_command', true), { command: 'show version' }).kind).toBe('ask');
    expect(decide(junos('execute_junos_command', true), { command: 'configure' }).kind).toBe('ask');
    expect(decide(junos('execute_junos_command', true), { command: 'show version', confirm: true }).kind).toBe('ask');
    // The opt-in needs the Junos preset.
    expect(decide(tool('execute_junos_command', { showOptIn: true }), { command: 'show version' }).kind).toBe('ask');
  });

  it('adds the Junos commit note', () => {
    const d = asked(decide(junos('load_and_commit_config'), { config: 'set system host-name x' }));
    expect(d.label).toBe('destructive');
    expect(d.notes).toContain('load_and_commit_config commits right away. No preview and no auto-rollback');
  });

  it('runs a tool the server marks diagnostic', () => {
    expect(decide(tool('probe_link', { _meta: { 'casper/safety': 'diagnostic' } }))).toEqual({
      kind: 'run',
      label: 'diagnostic',
      why: 'read',
    });
  });

  it('lets the Rust label only raise a tool', () => {
    expect(effectiveLabel(tool('get_device', { annotations: READ_ONLY, label: 'destructive' }))).toBe('destructive');
    expect(effectiveLabel(tool('delete_site', { label: 'read' }))).toBe('destructive');
  });

  it('keeps the names safe to show', () => {
    const name = `get_${String.fromCodePoint(0x202e)}x`;
    const d = asked(decide(tool('invoke_tool'), { name }));
    expect(d.notes.join('\n')).not.toContain(String.fromCodePoint(0x202e));
    expect(d.notes).toContain('Runs get_\\u{202E}x through invoke_tool');
  });
});

describe('callLabel', () => {
  it('raises a routed call whose name does not clearly read', () => {
    const plan = buildPlan({
      server: 's',
      tool: 'invoke_read_tool',
      label: 'read',
      schema: { type: 'object' },
      arguments: { name: 'cycle_port' },
    });
    expect(callLabel(plan)).toBe('external-action');
  });
});

describe('toolFingerprint', () => {
  it('changes when the tool is redefined', () => {
    const a = tool('get_device', { annotations: READ_ONLY });
    expect(toolFingerprint(a)).toBe(toolFingerprint({ ...a, annotations: { readOnlyHint: true } }));
    expect(toolFingerprint(a)).not.toBe(toolFingerprint({ ...a, annotations: { readOnlyHint: false } }));
    expect(toolFingerprint(a)).not.toBe(toolFingerprint({ ...a, description: 'now deletes too' }));
    expect(toolFingerprint(a)).not.toBe(toolFingerprint({ ...a, preset: 'netbox' }));
    // Key order doesn't matter.
    const s1 = tool('x', { inputSchema: { type: 'object', properties: { a: {}, b: {} } } });
    const s2 = tool('x', { inputSchema: { properties: { b: {}, a: {} }, type: 'object' } });
    expect(toolFingerprint(s1)).toBe(toolFingerprint(s2));
  });
});

describe('readNamed', () => {
  it('is true only for names that clearly read', () => {
    expect(readNamed('get_device')).toBe(true);
    expect(readNamed('list_sites')).toBe(true);
    expect(readNamed('cycle_port')).toBe(false);
    expect(readNamed('get_and_delete_site')).toBe(false);
    expect(readNamed('invoke_read_tool_x')).toBe(false);
    expect(readNamed('set_status')).toBe(false);
  });
});
