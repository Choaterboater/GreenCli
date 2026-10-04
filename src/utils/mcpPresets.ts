// Partly copied from casper src/mcp/presets.ts @ ad678b6 (MIT): the Junos
// show-only parser (presets.ts:209-227), the label tighten rules
// (presets.ts:275, 314-318, 353) and the Junos approval notes (presets.ts:321-325).
// Keep in step by hand. Matching a server to a preset is done in Rust
// (src-tauri/src/mcp/presets.rs); this file only reads tool.preset.
//
// Changed here: isPlainJunosShow first refuses any character outside
// printable ASCII and tab (see below), and the notes have no trailing period
// (bullet style, like the other approval notes).

import { AI_WRITE_PIPE } from './aiGating';
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

/** The longest line isPlainShow allows. */
export const MAX_SHOW_LEN = 256;

/** isPlainShow's filters: JUNOS_PIPES without trim, plus include, exclude, begin and section with
 *  their short forms. Never `s` (save on Junos), grep, head, tail, wc or a pipe that writes a file.
 *  Never trim, and display only alone or as `display set` (see isPlainShow). */
export const SHOW_PIPES: ReadonlySet<string> = new Set([
  ...[...JUNOS_PIPES].filter((pipe) => pipe !== 'trim'),
  ...['i', 'in', 'inc', 'incl', 'inclu', 'includ', 'include'],
  ...['e', 'ex', 'exc', 'excl', 'exclu', 'exclud', 'exclude'],
  ...['b', 'be', 'beg', 'begi', 'begin'],
  ...['sec', 'sect', 'secti', 'sectio', 'section'],
]);

/** isPlainShow's filters whose text is a pattern: these may also use ^ $ * ( ) [ ] in their text. */
export const PATTERN_PIPES: ReadonlySet<string> = new Set([
  ...['match', 'except', 'find'],
  ...['i', 'in', 'inc', 'incl', 'inclu', 'includ', 'include'],
  ...['e', 'ex', 'exc', 'excl', 'exclu', 'exclud', 'exclude'],
  ...['b', 'be', 'beg', 'begi', 'begin'],
  ...['sec', 'sect', 'secti', 'sectio', 'section'],
]);

/** The Read-only Auditor's characters (AUDITOR_CHAR in aiGating.ts), without quotes. */
const SHOW_CHARS = /^[A-Za-z0-9 \t._/:@,=+|-]*$/;
/** SHOW_CHARS plus ^ $ * ( ) [ ], for a PATTERN_PIPES filter's text only. Never ? (AOS-CX and Junos
 *  show help at once and leave the line half-typed), quotes, backtick, backslash, ; & < >. */
const PATTERN_CHARS = /^[A-Za-z0-9 \t._/:@,=+|^$*()[\]-]*$/;

/**
 * The show-only rule for live show commands from AI tools outside GreenCLI, extended from
 * isPlainJunosShow: one line, never empty, at most 256 characters, only the Auditor's characters
 * (plus ^ $ * ( ) [ ] in a PATTERN_PIPES filter's text; a | always starts a new stage),
 * the literal first word `show` (no `do`, no `sh`) then a word starting with a letter, and every
 * `|` stage a SHOW_PIPES filter, with `display` only alone or as `display set`: secrets are hidden
 * by the word in front of them on the same line, and trim, xml or json would move that word away.
 * greencli-mcp's is_plain_show (src-tauri/greencli-mcp/src/
 * show_only.rs, also used by the app) is the same rule; both run
 * src-tauri/greencli-mcp/testdata/show_only_cases.json.
 */
export function isPlainShow(line: unknown): boolean {
  if (typeof line !== 'string' || line.length > MAX_SHOW_LEN || !PATTERN_CHARS.test(line)) return false;
  if (AI_WRITE_PIPE.test(line)) return false;
  const [head = '', ...rest] = line.split('|');
  if (!SHOW_CHARS.test(head)) return false;
  const words = head.split(/[ \t]+/).filter(Boolean);
  if (words[0] !== 'show' || !/^[A-Za-z]/.test(words[1] ?? '')) return false;
  return rest.every((stage) => {
    const [first = '', ...more] = stage.split(/[ \t]+/).filter(Boolean);
    if (PATTERN_PIPES.has(first)) return true;
    if (!SHOW_CHARS.test(stage)) return false;
    if (first === 'display') return more.length === 0 || (more.length === 1 && more[0] === 'set');
    return SHOW_PIPES.has(first);
  });
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
