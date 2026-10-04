// GreenCLI's own MCP checks (mcpLabels.ts, the approval box's router check)
// agree with greencli-mcp's tool list: every tool is Read except device_show
// (diagnostic: it runs a show line on a connected tab), and none is a router.
// The list is the server's golden file, checked against the server by Rust.

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { toolLabel } from './mcpLabels';
import { isRouterName } from './mcpApproval';

interface ListedTool {
  name: string;
  annotations?: Record<string, unknown>;
  _meta?: Record<string, unknown>;
  inputSchema: { additionalProperties?: boolean };
}

const TOOLS: ListedTool[] = JSON.parse(
  readFileSync(resolve(process.cwd(), 'src-tauri/greencli-mcp/testdata/tools_list.json'), 'utf8'),
);

describe('greencli-mcp tools', () => {
  it('has the seven read tools and the two live tools', () => {
    expect(TOOLS.map((t) => t.name)).toEqual([
      'access_check',
      'list_devices',
      'list_archive_devices',
      'list_config_history',
      'get_config',
      'get_config_diff',
      'list_intents',
      'list_connected_devices',
      'device_show',
    ]);
  });

  it.each(TOOLS.map((t) => [t.name, t] as const))('%s is labelled read or diagnostic', (name, tool) => {
    const want = name === 'device_show' ? 'diagnostic' : 'read';
    expect(toolLabel(tool as Parameters<typeof toolLabel>[0])).toBe(want);
    expect(isRouterName(tool.name)).toBe(false);
    expect(tool.inputSchema.additionalProperties).toBe(false);
  });
});
