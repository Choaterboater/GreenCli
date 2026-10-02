// Partly copied from casper src/mcp/presets.ts @ ad678b6 (MIT): the Junos
// show-only parser (presets.ts:209-227), the label tighten rules
// (presets.ts:275, 314-318, 353) and the Junos approval notes (presets.ts:321-325).
// Keep in step by hand. Matching a server to a preset is done in Rust
// (src-tauri/src/mcp/presets.rs); this file only reads tool.preset.
//
// Changed here: isPlainJunosShow first refuses any character outside
// printable ASCII and tab (see below), and the notes have no trailing period
// (bullet style, like the other approval notes).

import { strictest, type CapabilitySafety } from './mcpLabels';
import type { McpPresetId } from './mcpTypes';

export const JUNOS_PRESET: McpPresetId = 'junos-mcp-server';

export const JUNOS_PIPES: ReadonlySet<string> = new Set([
  'match',
  'except',
  'count',
  'display',
  'no-more',
  'last',
  'find',
  'trim',
]);

/** Printable ASCII (0x20-0x7E) and tab only. */
const PLAIN_ASCII = /^[\t\x20-\x7e]*$/;

/**
 * A plain Junos `show` command: the literal word `show` first (no abbreviations), no `;`, no line
 * breaks, no redirection, and every `|` stage from a small read-only list (`| save` is refused).
 *
 * Casper's isPlainJunosShow (presets.ts:214-225) behind one extra GreenCLI check: every character
 * is printable ASCII (0x20-0x7E) or a tab. Junos commands are ASCII, and this makes the Rust and TS
 * parsers agree exactly (length = bytes = UTF-16 units; whitespace = space and tab only).
 */
export function isPlainJunosShow(command: unknown): boolean {
  if (typeof command !== 'string' || !PLAIN_ASCII.test(command)) return false;
  // ---- Casper presets.ts:215-224 below ----
  if (typeof command !== 'string' || command.length > 512) return false;
  if (/[;\r\n\u0000`>&$\\]/.test(command)) return false;
  const stages = command.split('|').map((stage) => stage.trim());
  const head = stages[0]!.split(/\s+/);
  if (head[0] !== 'show' || head.length < 2 || !/^[a-z]/.test(head[1]!)) return false;
  for (const stage of stages.slice(1)) {
    const word = stage.split(/\s+/)[0];
    if (!word || !JUNOS_PIPES.has(word)) return false;
  }
  return true;
}

export const JUNOS_EXECUTE: ReadonlySet<string> = new Set([
  'execute_junos_command',
  'execute_junos_command_batch',
  'execute_junos_pfe_command',
]);

export const JUNOS_WRITES_OFF = 'Junos writes are off; only show commands run.';

/** 'all-show' when every command/commands entry is a plain show (presets.ts:234-240); 'not-show'
 *  otherwise; 'n/a' for non-execute tools. */
export function junosShow(tool: string, args: Record<string, unknown>): 'all-show' | 'not-show' | 'n/a' {
  if (!JUNOS_EXECUTE.has(tool)) return 'n/a';
  const commands: unknown[] = [];
  if ('command' in args) commands.push(args.command);
  if ('commands' in args) {
    if (!Array.isArray(args.commands)) commands.push(undefined);
    else commands.push(...args.commands);
  }
  const allShow = commands.length > 0 && commands.every(isPlainJunosShow);
  return allShow ? 'all-show' : 'not-show';
}

/** Casper's preset tighten rules, through strictest so they can only raise a label. */
export function presetTighten(
  preset: McpPresetId | undefined,
  tool: string,
  label: CapabilitySafety
): CapabilitySafety {
  switch (preset) {
    case 'hpe-networking-mcp':
      return ['invoke_tool', 'invoke_tools_batch'].includes(tool) ? strictest(label, 'destructive') : label;
    case 'junos-mcp-server':
      if (tool === 'load_and_commit_config' || tool === 'render_and_apply_j2_template') {
        return strictest(label, 'destructive');
      }
      if (tool.startsWith('execute_')) return strictest(label, 'exec');
      return label;
    case 'netmiko-mcp':
      return /^send_|config/.test(tool) ? strictest(label, 'exec') : label;
    default:
      return label;
  }
}

/** The preset's own approval notes (presets.ts:321-325). */
export function presetNotes(preset: McpPresetId | undefined, tool: string): string[] {
  if (preset !== JUNOS_PRESET) return [];
  if (tool === 'load_and_commit_config') {
    return ['load_and_commit_config commits right away. No preview and no auto-rollback'];
  }
  if (tool === 'render_and_apply_j2_template') {
    return ['render_and_apply_j2_template commits when apply_config is true. Set dry_run to check first'];
  }
  return [];
}
