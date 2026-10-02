import { describe, expect, it } from 'vitest';
import { aiConfirm, buildPlan, needsApproval, planLabel, previewSwitchedOff, routedCalls } from './mcpApproval';

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

  it('is empty for a tool that is not a router', () => {
    expect(routedCalls('get_device', { name: 'delete_site' })).toEqual([]);
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
  });

  it('finds a preview switch turned off', () => {
    expect(previewSwitchedOff({ dry_run: false })).toEqual(['dry_run']);
    expect(previewSwitchedOff({ 'dry-run': 'false' })).toEqual(['dry-run']);
    expect(previewSwitchedOff({ dry_run: true })).toEqual([]);
  });
});
