import { describe, expect, it } from 'vitest';
import {
  argsDepth,
  callLabel,
  decideMcpCall,
  effectiveLabel,
  JUNOS_WRITES_OFF_TEXT,
  namesAChange,
  readNamed,
  readOnlyLoginText,
  toolFingerprint,
  TOO_DEEP,
  visibleToReadOnlyAgent,
  writesOffText,
  type McpGateDecision,
} from './mcpGate';
import { AUDITOR_REFUSAL } from './aiGating';
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
    const unclear = asked(decide(tool('invoke_read_tool', { annotations: READ_ONLY }), { target: 'x' }));
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
      "The AI set confirm by itself. That can skip the server's own check, so it runs only if you say Yes"
    );
    const two = asked(decide(tool('get_device', { annotations: READ_ONLY }), { confirm: 'yes', opts: { force: 1 } }));
    expect(two.notes).toContain(
      "The AI set confirm and force by itself. That can skip the server's own check, so it runs only if you say Yes"
    );
    // Any value but false or null: a server may read 2 or "false" as yes.
    expect(asked(decide(tool('get_device'), { confirm: 2 }, true)).choices).toEqual(['no', 'once']);
    const auditor = decideMcpCall({
      tool: tool('get_device', { annotations: READ_ONLY }),
      args: { force: 'false' },
      allowedForSession: false,
      readOnlyAgent: true,
    });
    expect(auditor).toEqual({ kind: 'refuse', text: AUDITOR_REFUSAL });
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

  it('asks about a tool the server marks diagnostic, as Casper does', () => {
    const d = asked(decide(tool('probe_link', { _meta: { 'casper/safety': 'diagnostic' } }), {}, true));
    expect(d.label).toBe('diagnostic');
    expect(d.choices).toEqual(['no', 'once']);
    expect(d.danger).toBe(false);
    expect(d.notes[0]).toBe("The server says this tool runs a check, but doesn't say it only reads");
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
    expect(readNamed('get_sync_status')).toBe(true);
  });

  it('is false when a change word comes after the read word', () => {
    for (const name of [
      'get_and_apply_config',
      'list_and_disable_ports',
      'verify_and_commit',
      'get_or_add_vlan',
      'show_and_push_config',
      'fetch_and_sync_inventory',
      'check_then_enable_port',
    ]) {
      expect(readNamed(name)).toBe(false);
      expect(namesAChange(name)).toBe(true);
      // Never offered for the session, and refused while writes are off.
      expect(asked(decide(tool(name), {}, true)).choices).toEqual(['no', 'once']);
      expect(decide(tool(name, { writes: 'off' }), {}, true)).toEqual({ kind: 'refuse', text: writesOffText('srv') });
    }
  });
});

describe('writes off, read-only login and the Read-only Auditor', () => {
  const off = (name: string, extra: Partial<McpToolInfo> = {}) => tool(name, { writes: 'off', ...extra });
  const refused = (text: string) => ({ kind: 'refuse', text });
  const auditor = (t: McpToolInfo, args: Record<string, unknown> = {}) =>
    decideMcpCall({ tool: t, args, allowedForSession: false, readOnlyAgent: true });

  it('lets the Rust label only make a tool stricter', () => {
    const d = asked(decide(tool('get_device', { annotations: READ_ONLY, label: 'destructive' })));
    expect(d.choices).toEqual(['no', 'once']);
    expect(d.danger).toBe(true);
  });

  it('refuses a write behind a read router before any box', () => {
    const t = off('invoke_read_tool', { annotations: READ_ONLY });
    expect(decide(t, { name: 'update_site' })).toEqual(refused(writesOffText('srv')));
    expect(decide(t, { tool_id: 'x' })).toEqual(refused(writesOffText('srv')));
    expect(decide(t, { name: 'cycle_port' })).toEqual(refused(writesOffText('srv')));
    // A routed read still asks, as every router call does.
    expect(asked(decide(t, { name: 'get_device' })).choices).toEqual(['no', 'once']);
  });

  it('refuses a router call that names two different tools', () => {
    // name is a harmless decoy; the server may read tool_name and delete the VLAN.
    const decoy = { name: 'get_status', tool_name: 'delete_vlan', arguments: { vlan: 10 } };
    expect(decide(off('call_tool'), { tool_name: 'delete_vlan', arguments: { vlan: 10 } })).toEqual(
      refused(writesOffText('srv'))
    );
    expect(decide(off('call_tool'), decoy)).toEqual(refused(writesOffText('srv')));
    expect(auditor(tool('call_tool', { writes: 'on' }), decoy)).toEqual(refused(AUDITOR_REFUSAL));
    // Writes on: it asks, and the box does not name the decoy.
    const d = asked(decide(tool('call_tool', { writes: 'on' }), decoy));
    expect(d.choices).toEqual(['no', 'once']);
    expect(d.notes).toContain("Runs a tool GreenCLI can't see, through call_tool");
    expect(d.notes.join('\n')).not.toContain('get_status');
    // The same name twice is fine.
    expect(asked(decide(tool('call_tool', { writes: 'on' }), { name: 'get_status', tool_name: 'get_status' })).notes).toContain(
      'Runs get_status through call_tool'
    );
  });

  it('treats a decoy name in any tool-name key as unclear', () => {
    const t = off('call_tool', { annotations: READ_ONLY });
    for (const key of ['toolName', 'tool_id', 'toolId', 'method', 'function']) {
      const args = { name: 'get_status', [key]: 'delete_vlan', arguments: { vlan: 10 } };
      expect(decide(t, args)).toEqual(refused(writesOffText('srv')));
      expect(auditor(tool('call_tool', { annotations: READ_ONLY, writes: 'on' }), args)).toEqual(refused(AUDITOR_REFUSAL));
    }
  });

  it('finds routers by name words and by shape', () => {
    const args = { name: 'delete_site', arguments: { id: 1 } };
    for (const name of ['call_read_tool', 'callTool', 'call-tool', 'tool_call', 'use_tool', 'proxy_tool', 'callReadTool']) {
      const t = off(name, { annotations: READ_ONLY });
      expect(decide(t, args)).toEqual(refused(writesOffText('srv')));
      expect(auditor(tool(name, { annotations: READ_ONLY, writes: 'on' }), args)).toEqual(refused(AUDITOR_REFUSAL));
      // A routed read still asks: a router call never runs without the box.
      expect(asked(decide(tool(name, { annotations: READ_ONLY, writes: 'on' }), { name: 'get_device' })).choices).toEqual([
        'no',
        'once',
      ]);
    }
    const shaped = off('helper', {
      annotations: READ_ONLY,
      inputSchema: { type: 'object', properties: { tool_name: {}, args: {} } },
    });
    expect(decide(shaped, { tool_name: 'delete_site', args: {} })).toEqual(refused(writesOffText('srv')));
  });

  it('never runs a read-only-hinted batch or {method, params} router without a box', () => {
    const on = (extra: Partial<McpToolInfo> = {}) => tool('helper', { annotations: READ_ONLY, writes: 'on', ...extra });
    const batch = { calls: [{ name: 'get_a', arguments: {} }, { name: 'delete_b', arguments: {} }] };
    const d = asked(decide(on(), batch));
    expect(d.label).toBe('destructive');
    expect(d.danger).toBe(true);
    expect(d.choices).toEqual(['no', 'once']);
    expect(asked(decide(on(), { method: 'reboot_ap', params: {} })).label).toBe('destructive');
    expect(asked(decide(on(), { function: 'get_device', arguments: {} })).choices).toEqual(['no', 'once']);
    expect(decide(off('helper', { annotations: READ_ONLY }), batch)).toEqual(refused(writesOffText('srv')));
    expect(auditor(on(), batch)).toEqual(refused(AUDITOR_REFUSAL));
    // A batch entry GreenCLI can't read: refused with writes off and for the Auditor, asks otherwise.
    const unclear = { requests: [{ method: 'get_a', params: {} }, { op: 'x' }] };
    expect(decide(off('helper', { annotations: READ_ONLY }), unclear)).toEqual(refused(writesOffText('srv')));
    expect(auditor(on(), unclear)).toEqual(refused(AUDITOR_REFUSAL));
    expect(asked(decide(on(), unclear)).notes.join('\n')).toContain("tools GreenCLI can't see");
    // A batch of reads that each clearly read: the Auditor lets it through, but it still asks.
    const reads = { calls: [{ name: 'get_a', arguments: {} }, { name: 'list_b', arguments: {} }] };
    expect(auditor(on(), reads).kind).toBe('ask');
  });

  it('finds a batch router inside a pydantic model, a tool_calls list or a nested object', () => {
    // FastMCP writes run_batch(request: BatchRequest) like this.
    const fastmcp = {
      type: 'object' as const,
      properties: { request: { $ref: '#/$defs/BatchRequest' } },
      $defs: {
        BatchRequest: { type: 'object', properties: { calls: { type: 'array', items: { $ref: '#/$defs/Call' } } } },
        Call: { type: 'object', properties: { name: { type: 'string' }, arguments: { type: 'object' } } },
      },
    };
    const deleteCall = { request: { calls: [{ name: 'delete_vlan', arguments: {} }] } };
    const batchTool = (extra: Partial<McpToolInfo> = {}) =>
      tool('run_batch', { annotations: READ_ONLY, inputSchema: fastmcp, ...extra });
    const plan = buildPlan({ server: 's', tool: 'run_batch', label: 'read', schema: fastmcp, arguments: deleteCall });
    expect(plan.router).toBe(true);
    expect(plan.routed.map((call) => call.name)).toEqual(['delete_vlan']);
    expect(decide(batchTool({ writes: 'off' }), deleteCall)).toEqual(refused(writesOffText('srv')));
    expect(auditor(batchTool({ writes: 'on' }), deleteCall)).toEqual(refused(AUDITOR_REFUSAL));
    expect(asked(decide(batchTool({ writes: 'on' }), deleteCall)).label).toBe('destructive');
    // No schema at all: the shapes in the call are enough.
    for (const args of [
      { tool_calls: [{ id: 'c1', type: 'function', function: { name: 'delete_vlan', arguments: '{}' } }] },
      { batch: { calls: [{ name: 'delete_vlan' }] } },
      { calls: [[{ name: 'delete_vlan', arguments: {} }]] },
      deleteCall,
    ]) {
      expect(decide(off('helper', { annotations: READ_ONLY }), args)).toEqual(refused(writesOffText('srv')));
      expect(auditor(tool('helper', { annotations: READ_ONLY, writes: 'on' }), args)).toEqual(refused(AUDITOR_REFUSAL));
    }
    // A map of calls the schema describes with additionalProperties.
    const mapTool = off('helper', {
      annotations: READ_ONLY,
      inputSchema: {
        type: 'object' as const,
        properties: { ops: { type: 'object', additionalProperties: { $ref: '#/$defs/Call' } } },
        $defs: fastmcp.$defs,
      },
    });
    expect(decide(mapTool, { ops: { a: { name: 'delete_vlan' } } })).toEqual(refused(writesOffText('srv')));
  });

  it('reads a batch sent as JSON text next to a visible call (FastMCP json.loads it)', () => {
    const fastmcp = {
      type: 'object' as const,
      properties: { request: { $ref: '#/$defs/Call' }, batch: { type: 'array', items: { $ref: '#/$defs/Call' } } },
      $defs: { Call: { type: 'object', properties: { name: { type: 'string' }, arguments: { type: 'object' } } } },
    };
    const args = {
      request: { name: 'get_status', arguments: {} },
      batch: JSON.stringify([{ name: 'delete_vlan', arguments: {} }]),
    };
    const runTool = (extra: Partial<McpToolInfo> = {}) =>
      tool('run', { annotations: READ_ONLY, inputSchema: fastmcp, ...extra });
    expect(decide(runTool({ writes: 'off' }), args)).toEqual(refused(writesOffText('srv')));
    expect(auditor(runTool({ writes: 'on' }), args)).toEqual(refused(AUDITOR_REFUSAL));
    expect(asked(decide(runTool({ writes: 'on' }), args)).label).toBe('destructive');
    // Text that starts like JSON but doesn't parse: the server may read it some other way.
    const broken = { request: { name: 'get_status', arguments: {} }, batch: '[{"name": "delete_vlan", ' };
    expect(decide(runTool({ writes: 'off' }), broken)).toEqual(refused(writesOffText('srv')));
    expect(auditor(runTool({ writes: 'on' }), broken)).toEqual(refused(AUDITOR_REFUSAL));
    expect(asked(decide(runTool({ writes: 'on' }), broken)).notes.join('\n')).toContain("tools GreenCLI can't see");
  });

  it('fails closed on JSON text it cannot read, router or not: refused with writes off and for the Auditor, asked otherwise', () => {
    const helper = (extra: Partial<McpToolInfo> = {}) => tool('helper', { annotations: READ_ONLY, ...extra });
    let deep = '{"force": true}';
    for (let i = 1; i < 40; i++) deep = `{"a": ${deep}}`;
    for (const args of [
      { calls: '[{"name":"delete_vlan","arguments":{"x":1e400}}]' },
      { calls: '[{"name":"delete_vlan","arguments":{"x":"\\ud800"}}]' },
      { request: '{"calls":[{"name":"delete_vlan"}], "x":1e400}' },
      { options: '{"force": true, "n": 1e400}' },
      { payload: deep },
    ]) {
      expect([args, decide(helper({ writes: 'off' }), args)]).toEqual([args, refused(writesOffText('srv'))]);
      expect([args, auditor(helper({ writes: 'on' }), args)]).toEqual([args, refused(AUDITOR_REFUSAL)]);
      const d = asked(decide(helper({ writes: 'on' }), args, true));
      expect(d.choices).toEqual(['no', 'once']);
      expect(d.notes).toContain(
        "A value in the arguments starts like JSON but GreenCLI can't read it, so it can't see what the server will do with it"
      );
    }
    // Text that reads fine still runs.
    expect(decide(helper({ writes: 'off' }), { filter: '{"site": 1}', ports: '[1, 2]' })).toEqual({ kind: 'run', label: 'read', why: 'read' });
  });

  it('counts force="t" as the AI skipping a check (pydantic reads it as true)', () => {
    expect(decide(tool('list_sessions'), { force: 'true' }, true).kind).toBe('ask');
    expect(decide(tool('list_sessions'), { force: 't' }, true).kind).toBe('ask');
    expect(auditor(tool('get_device', { annotations: READ_ONLY }), { confirm: 'T' })).toEqual(refused(AUDITOR_REFUSAL));
  });

  it('counts a confirm, force or dry_run inside a JSON-text routed call as the AI skipping a check', () => {
    const router = tool('invoke_read_tool', { annotations: READ_ONLY });
    const calls = [{ name: 'get_status', arguments: {} }, { name: 'get_status', arguments: { force: true } }];
    for (const args of [{ calls }, { calls: JSON.stringify(calls) }, { request: JSON.stringify({ calls: JSON.stringify(calls) }) }]) {
      const d = asked(decide(router, args, true));
      expect([args, d.label]).toEqual([args, 'read']);
      expect(d.notes).toContain(
        "The AI set force by itself. That can skip the server's own check, so it runs only if you say Yes"
      );
      expect(auditor(router, args)).toEqual(refused(AUDITOR_REFUSAL));
    }
    const preview = asked(decide(router, { calls: JSON.stringify([{ name: 'get_status', arguments: { dry_run: false } }]) }, true));
    expect(preview.notes).toContain('The AI turned off dry_run, so this makes the change instead of only showing it');
    const confirm = { name: 'get_status', arguments: JSON.stringify({ confirm: 'yes' }) };
    expect(auditor(router, confirm)).toEqual(refused(AUDITOR_REFUSAL));
  });

  it('refuses writes and destructive tools, but asks about commands', () => {
    expect(decide(off('set_ssid'))).toEqual(refused(writesOffText('srv')));
    expect(decide(off('delete_site'))).toEqual(refused(writesOffText('srv')));
    const d = asked(decide(off('execute_command')));
    expect(d.label).toBe('exec');
    expect(d.choices).toEqual(['no', 'once']);
    expect(decide(tool('set_ssid', { writes: 'on' })).kind).toBe('ask');
  });

  it('refuses a command tool whose name also makes a change', () => {
    for (const name of ['push_cli_config', 'apply_config_command']) {
      expect(decide(off(name))).toEqual(refused(writesOffText('srv')));
      expect(decide(off(name, { annotations: READ_ONLY }))).toEqual(refused(writesOffText('srv')));
      expect(asked(decide(tool(name, { writes: 'on' }))).label).toBe('exec');
    }
  });

  it('allows only plain show commands on Junos', () => {
    const junosOff = (name: string) => off(name, { preset: 'junos-mcp-server' });
    expect(decide(junosOff('execute_junos_command'), { command: 'configure' })).toEqual(refused(JUNOS_WRITES_OFF_TEXT));
    expect(JUNOS_WRITES_OFF_TEXT).toBe(
      'Not run: Junos writes are off; only show commands run. Only the user can turn writes on, in Settings → MCP Servers.'
    );
    expect(decide(junosOff('load_and_commit_config'))).toEqual(refused(JUNOS_WRITES_OFF_TEXT));
    expect(decide(junosOff('execute_junos_command'), { command: 'show version' }).kind).toBe('ask');
  });

  it('refuses a change on a read-only login', () => {
    const t = tool('invoke_read_tool', { annotations: READ_ONLY, access: 'read-only', writes: 'on' });
    expect(decide(t, { name: 'update_site' })).toEqual(refused(readOnlyLoginText('srv')));
    expect(decide(tool('get_device', { annotations: READ_ONLY, access: 'read-only' })).kind).toBe('run');
  });

  it('the Read-only Auditor runs reads and refuses everything else', () => {
    expect(auditor(tool('set_ssid'))).toEqual(refused(AUDITOR_REFUSAL));
    expect(auditor(tool('get_device'))).toEqual(refused(AUDITOR_REFUSAL));
    expect(auditor(tool('get_device', { annotations: READ_ONLY }))).toEqual({ kind: 'run', label: 'read', why: 'read' });
    expect(auditor(tool('get_device', { annotations: READ_ONLY }), { confirm: true })).toEqual(refused(AUDITOR_REFUSAL));
    // A Junos plain show is not refused (it still asks without the opt-in).
    expect(auditor(junos('execute_junos_command'), { command: 'show version' }).kind).toBe('ask');
    expect(auditor(junos('execute_junos_command', true), { command: 'show version' }).kind).toBe('run');
    expect(auditor(junos('execute_junos_command'), { command: 'configure' })).toEqual(refused(AUDITOR_REFUSAL));
    expect(auditor(junos('execute_junos_pfe_command'), { command: 'show version' })).toEqual(refused(AUDITOR_REFUSAL));
    // A diagnostic check is not refused, but it asks.
    expect(auditor(tool('ap_ping', { _meta: { 'casper/safety': 'diagnostic' } })).kind).toBe('ask');
  });

  it('shows the Auditor only tools the server marks read-only or diagnostic, and Junos show tools', () => {
    expect(visibleToReadOnlyAgent(tool('get_device', { annotations: READ_ONLY }))).toBe(true);
    expect(visibleToReadOnlyAgent(tool('ap_ping', { _meta: { 'casper/safety': 'diagnostic' } }))).toBe(true);
    expect(visibleToReadOnlyAgent(tool('get_device'))).toBe(false);
    expect(visibleToReadOnlyAgent(tool('get_device', { annotations: READ_ONLY, label: 'write' }))).toBe(false);
    expect(visibleToReadOnlyAgent(junos('execute_junos_command'))).toBe(true);
    expect(visibleToReadOnlyAgent(junos('execute_junos_command_batch'))).toBe(true);
    expect(visibleToReadOnlyAgent(junos('execute_junos_pfe_command'))).toBe(false);
    expect(visibleToReadOnlyAgent(tool('execute_junos_command'))).toBe(false);
  });
});
