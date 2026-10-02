// The Rust side (src-tauri/src/mcp/labels.rs and presets.rs) labels tools,
// parses Junos show commands and spots skipped checks the same way this side
// does. Both test suites read these fixtures, so a drift on either side fails.
//
// The fixtures hold what the TypeScript functions return. After a deliberate
// change, regenerate them from TS and check the Rust tests still pass.

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { buildPlan, MAX_DEPTH, skippedCheck } from './mcpApproval';
import { argsDepth, readNamed, writesOffHides } from './mcpGate';
import { toolLabel, type CapabilitySafety } from './mcpLabels';
import { isPlainJunosShow } from './mcpPresets';

function fixture<T>(name: string): T[] {
  return JSON.parse(readFileSync(resolve(process.cwd(), 'src-tauri/src/mcp/testdata', name), 'utf8')) as T[];
}

interface LabelCase {
  name: string;
  annotations?: { readOnlyHint?: boolean; destructiveHint?: boolean };
  _meta?: Record<string, unknown>;
  label: CapabilitySafety;
  readNamed: boolean;
}

describe('MCP label fixtures shared with Rust', () => {
  const labels = fixture<LabelCase>('label_cases.json');

  it('has enough cases', () => {
    expect(labels.length).toBeGreaterThanOrEqual(60);
  });

  it.each(labels.map((c) => [JSON.stringify({ ...c, label: undefined, readNamed: undefined }), c] as const))(
    'label and readNamed of %s',
    (_title, c) => {
      expect(toolLabel(c)).toBe(c.label);
      expect(readNamed(c.name)).toBe(c.readNamed);
    }
  );

  it('what writes off hides', () => {
    const cases = fixture<{ name: string; annotations?: { readOnlyHint?: boolean }; hides: boolean }>(
      'writes_off_cases.json'
    );
    expect(cases.length).toBeGreaterThanOrEqual(10);
    for (const c of cases) {
      expect([c, writesOffHides(toolLabel(c), c.name)]).toEqual([c, c.hides]);
    }
  });

  it('Junos plain show commands', () => {
    const cases = fixture<{ command: string; plain: boolean }>('junos_show_cases.json');
    expect(cases.some((c) => c.command.length === 512 && c.plain)).toBe(true);
    expect(cases.some((c) => c.command.length === 513 && !c.plain)).toBe(true);
    for (const c of cases) expect([c.command, isPlainJunosShow(c.command)]).toEqual([c.command, c.plain]);
  });

  it('skipped checks, with nesting over 32 and unreadable JSON text counted as skipped', () => {
    const cases = fixture<{ args: Record<string, unknown>; skipped: boolean }>('skip_cases.json');
    for (const c of cases) {
      const skipped = skippedCheck(c.args) || argsDepth(c.args) > MAX_DEPTH;
      expect([c.args, skipped]).toEqual([c.args, c.skipped]);
    }
  });

  it('router calls: the tools they name, and when GreenCLI cannot tell', () => {
    const cases = fixture<{
      tool: string;
      schema?: Record<string, unknown>;
      args: Record<string, unknown>;
      routed: string[];
      unclear: boolean;
    }>('router_cases.json');
    expect(cases.length).toBeGreaterThanOrEqual(10);
    for (const c of cases) {
      const schema = (c.schema ?? { type: 'object' }) as Parameters<typeof buildPlan>[0]['schema'];
      const plan = buildPlan({ server: 's', tool: c.tool, label: 'read', schema, arguments: c.args });
      expect([c.tool, c.args, plan.routed.map((call) => call.name), plan.routerUnclear]).toEqual([
        c.tool,
        c.args,
        c.routed,
        c.unclear,
      ]);
    }
  });
});
