import { describe, expect, it } from 'vitest';
import {
  aiConfirm,
  buildPlan,
  isRouter,
  isRouterName,
  needsApproval,
  planLabel,
  previewSwitchedOff,
  routedCalls,
} from './mcpApproval';

const schema = { type: 'object' as const };

describe('routedCalls', () => {
  it('finds the real tool behind a router call', () => {
    expect(routedCalls('invoke_tool', { name: 'port_bounce', arguments: { serial_number: 'SG1' } })).toEqual([
      { name: 'port_bounce', arguments: { serial_number: 'SG1' } },
    ]);
    expect(routedCalls('invoke_tool', { tool: 'get_x', args: { a: 1 } })).toEqual([
      { name: 'get_x', arguments: { a: 1 } },
    ]);
    expect(
      routedCalls('invoke_tools_batch', { calls: [{ name: 'a' }, { tool_name: 'b', params: { c: 1 } }] })
    ).toEqual([
      { name: 'a', arguments: {} },
      { name: 'b', arguments: { c: 1 } },
    ]);
  });

  it('does not pick one of two different names', () => {
    expect(routedCalls('call_tool', { name: 'get_status', tool_name: 'delete_vlan' })).toEqual([]);
    expect(routedCalls('call_tool', { name: 'get_status', tool: 'get_status' })).toEqual([
      { name: 'get_status', arguments: {} },
    ]);
    const plan = buildPlan({
      server: 's',
      tool: 'invoke_tools_batch',
      label: 'read',
      schema,
      arguments: { name: 'get_a', tool: 'delete_b', calls: [{ name: 'get_c' }] },
    });
    expect(plan.routed.map((call) => call.name)).toEqual(['get_c']);
    expect(plan.routerUnclear).toBe(true);
  });

  it('is empty for a tool that is not a router', () => {
    expect(routedCalls('get_device', { name: 'delete_site' })).toEqual([]);
    expect(routedCalls('get_route', { name: 'core1', params: {} })).toEqual([]);
  });

  it('finds a router by its name words or its shape', () => {
    for (const name of ['call_read_tool', 'callTool', 'call-tool', 'tool_call', 'use_tool', 'proxy_tool']) {
      expect(isRouterName(name)).toBe(true);
    }
    for (const name of ['get_route', 'get_proxy_config', 'list_tools', 'show_call_log']) {
      expect(isRouterName(name)).toBe(false);
    }
    expect(isRouter('helper', { type: 'object', properties: { toolName: {}, params: {} } })).toBe(true);
    expect(isRouter('helper', { type: 'object' }, { name: 'delete_site', arguments: {} })).toBe(true);
    expect(isRouter('helper', { type: 'object', properties: { name: {}, params: {} } })).toBe(false);
  });

  it('reads the tool name from any key that may hold it', () => {
    expect(routedCalls('call_tool', { toolName: 'get_x' })).toEqual([{ name: 'get_x', arguments: {} }]);
    expect(routedCalls('call_tool', { name: 'get_status', toolName: 'delete_vlan' })).toEqual([]);
    expect(routedCalls('call_tool', { name: 'get_status', method: 'delete_vlan' })).toEqual([]);
  });
});

describe('buildPlan and planLabel', () => {
  it('marks a router that names nothing as unclear', () => {
    const plan = buildPlan({ server: 's', tool: 'invoke_tool', label: 'read', schema, arguments: {} });
    expect(plan.routerUnclear).toBe(true);
    expect(planLabel(plan)).toBe('external-action');
  });

  it('marks a batch with an entry it cannot read as unclear', () => {
    const plan = buildPlan({
      server: 's',
      tool: 'invoke_tools_batch',
      label: 'read',
      schema,
      arguments: { calls: [{ name: 'get_a' }, { nope: 1 }] },
    });
    expect(plan.routed).toHaveLength(1);
    expect(plan.routerUnclear).toBe(true);
  });

  it('judges a router call by the tool it runs', () => {
    const plan = buildPlan({
      server: 's',
      tool: 'invoke_read_tool',
      label: 'read',
      schema,
      arguments: { name: 'delete_site' },
    });
    expect(planLabel(plan)).toBe('destructive');
    expect(needsApproval(plan)).toBe(true);
  });
});

describe('the AI skipping a check', () => {
  it('finds confirm=yes anywhere, in any spelling', () => {
    expect(aiConfirm({ Confirm: 'yes' })).toEqual(['Confirm']);
    expect(aiConfirm({ arguments: { force: 1 } })).toEqual(['arguments.force']);
    expect(aiConfirm({ confirm: false })).toEqual([]);
    expect(aiConfirm({ force: 't', confirmed: ' T ' })).toEqual(['force', 'confirmed']);
    // A server that reads `if (args.force)` takes these as yes too.
    expect(aiConfirm({ force: 'f', confirm: 2, confirmed: 'no', confirmation: {} })).toEqual([
      'force',
      'confirm',
      'confirmed',
      'confirmation',
    ]);
    expect(aiConfirm({ force: null })).toEqual([]);
  });

  it('finds a preview switch turned off', () => {
    expect(previewSwitchedOff({ dry_run: false })).toEqual(['dry_run']);
    expect(previewSwitchedOff({ 'dry-run': 'false' })).toEqual(['dry-run']);
    expect(previewSwitchedOff({ dry_run: true })).toEqual([]);
  });
});
