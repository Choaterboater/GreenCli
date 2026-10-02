// The single decision for an AI-issued MCP call: run it, ask the user, or
// refuse. Pure: no Tauri, no stores. Uses Casper's tool labels (mcpLabels.ts)
// and approval checks (mcpApproval.ts), and GreenCLI's preset rules.
//
// What it promises:
// - With a server's writes off, or on a read-only login, a call that would
//   change something is refused before any dialog (the Rust backend refuses
//   it again). The Read-only Auditor refuses everything above diagnostic
//   (a check such as ping), except Junos plain show commands.
// - Only a read runs without asking (Casper's needsApproval): a diagnostic
//   tool, a call that might write, run commands or delete, any router call
//   (invoke_tool and friends) and any call where the AI set confirm or
//   turned off a preview switch all ask.
// - Only a tool whose name clearly reads, and that the server just doesn't
//   mark read-only, can be allowed for the session.
// - Labels only get stricter: the server's hints, the name, the preset and
//   the Rust label are combined with strictest().

import {
  aiConfirm,
  buildPlan,
  isRouterName,
  MAX_DEPTH,
  planLabel,
  previewSwitchedOff,
  type ApprovalPlan,
} from './mcpApproval';
import {
  DESTRUCTIVE_WORDS,
  EXEC_WORDS,
  NOUN_USES,
  READ_NOUN_ENDINGS,
  READ_WORDS,
  SAFETY_RANK,
  WRITE_WORDS,
  nameLabel,
  strictest,
  toolLabel,
  toolWords,
  type CapabilitySafety,
} from './mcpLabels';
import { AUDITOR_REFUSAL } from './aiGating';
import { JUNOS_PRESET, JUNOS_WRITES_OFF, junosShow, presetNotes, presetTighten } from './mcpPresets';
import { showName } from './mcpShow';
import type { McpToolInfo } from './mcpTypes';

export type McpAnswer = 'no' | 'once' | 'session';

/** Calls at or above this label ask the user. Everything but a read asks, as in Casper. */
export const ASK_AT: CapabilitySafety = 'diagnostic';

export const TOO_DEEP = 'Not run: the arguments are nested too deeply to check (over 32 levels).';

export const writesOffText = (server: string) =>
  `Not run: ${server} writes are off. Only the user can turn them on, in Settings → MCP Servers.`;
export const readOnlyLoginText = (server: string) => `Not run: ${server} login is read-only.`;
export const JUNOS_WRITES_OFF_TEXT = `Not run: ${JUNOS_WRITES_OFF} Only the user can turn writes on, in Settings → MCP Servers.`;

/** Junos tools that commit a change. */
const JUNOS_COMMIT_TOOLS = new Set(['load_and_commit_config', 'render_and_apply_j2_template']);
/** Junos tools the Read-only Auditor may use, for plain show commands only. */
const JUNOS_SHOW_TOOLS = new Set(['execute_junos_command', 'execute_junos_command_batch']);

export function rank(label: CapabilitySafety): number {
  return SAFETY_RANK[label];
}

/** The tool's own label: the server's hints and the name (Casper's toolLabel), the preset's
 *  tighten rules, and the Rust label when there is one. Never looser than any of them. */
export function effectiveLabel(tool: McpToolInfo): CapabilitySafety {
  const own = toolLabel(tool);
  return strictest(own, presetTighten(tool.preset, tool.name, own), tool.label ?? 'read');
}

/**
 * A change, run or delete word anywhere in the name. Skipped, as in Casper's wordLabel: the
 * NOUN_USES words for that exact name, and a change word just before a read noun ending
 * (get_write_status reads the write status). Casper's labels skip every change word after a
 * read word (get_and_apply_config reads as `read`); GreenCLI doesn't when deciding what writes off
 * hides and what can be allowed for the session.
 */
export function namesAChange(name: string): boolean {
  const skipped = new Set(NOUN_USES.get(name) ?? []);
  const words = toolWords(name).filter((word) => !skipped.has(word));
  const describing = words.length >= 3 && READ_NOUN_ENDINGS.has(words.at(-1)!) ? words.length - 2 : -1;
  return words.some(
    (word, index) =>
      DESTRUCTIVE_WORDS.has(word) || EXEC_WORDS.has(word) || (index !== describing && WRITE_WORDS.has(word))
  );
}

/**
 * "Clearly reads by its name": the first action word of the name is a read word (get, list,
 * show, ...), nothing in the name says otherwise (nameLabel is read, and no change word comes
 * later: get_and_apply_config doesn't count), and it is not a router.
 * GreenCLI addition to the spec rule: a router name (invoke_read_tool_x) never counts, since
 * what it runs is decided by its arguments.
 */
export function readNamed(name: string): boolean {
  if (isRouterName(name)) return false;
  const skipped = new Set(NOUN_USES.get(name) ?? []);
  const words = toolWords(name).filter((word) => !skipped.has(word));
  const firstAction = words.find((word) => READ_WORDS.has(word) || WRITE_WORDS.has(word));
  return (
    firstAction !== undefined && READ_WORDS.has(firstAction) && nameLabel(name) === 'read' && !namesAChange(name)
  );
}

/** With writes off, an unmarked tool whose name has a change word is treated as a write: hidden
 *  and refused (the Rust policy hides it too). A tool the server marks read-only keeps its label. */
export function writesOffHides(label: CapabilitySafety, name: string): boolean {
  return label === 'write' || label === 'destructive' || (label === 'external-action' && namesAChange(name));
}

/** planLabel(plan), raised to at least 'external-action' for each routed call whose name is not readNamed. */
export function callLabel(plan: ApprovalPlan): CapabilitySafety {
  const unclearNames = plan.routed.some((call) => !readNamed(call.name));
  return strictest(planLabel(plan), ...(unclearNames ? ['external-action' as const] : []));
}

/** Deepest nesting of arrays/objects in args (top-level object = 1). Iterative, so a very deep
 *  value can't overflow the stack. */
export function argsDepth(args: unknown): number {
  let deepest = 0;
  const stack: Array<[unknown, number]> = [[args, 1]];
  while (stack.length) {
    const [value, depth] = stack.pop()!;
    if (typeof value !== 'object' || value === null) continue;
    if (depth > deepest) deepest = depth;
    for (const item of Array.isArray(value) ? value : Object.values(value)) {
      if (typeof item === 'object' && item !== null) stack.push([item, depth + 1]);
    }
  }
  return deepest;
}

function stable(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stable);
  if (typeof value === 'object' && value !== null) {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value).sort()) out[key] = stable((value as Record<string, unknown>)[key]);
    return out;
  }
  return value;
}

/** Stable JSON of name, description, inputSchema, annotations, _meta, preset, label (keys sorted).
 *  A tool the server redefines (or that changes preset or label) gets a new fingerprint. */
export function toolFingerprint(tool: McpToolInfo): string {
  return JSON.stringify(
    stable({
      name: tool.name,
      description: tool.description,
      inputSchema: tool.inputSchema,
      annotations: tool.annotations ?? null,
      _meta: tool._meta ?? null,
      preset: tool.preset ?? null,
      label: tool.label ?? null,
    })
  );
}

export interface McpGateInput {
  tool: McpToolInfo;
  args: Record<string, unknown>;
  /** The caller checks the stored fingerprint (mcpApprovalStore). */
  allowedForSession: boolean;
  /** The Read-only Auditor is attached: only reads (and Junos plain shows) may run. */
  readOnlyAgent: boolean;
}

export type McpGateDecision =
  | { kind: 'run'; label: CapabilitySafety; why: 'read' | 'session' | 'junos-show' }
  | { kind: 'ask'; label: CapabilitySafety; plan: ApprovalPlan; notes: string[]; choices: McpAnswer[]; danger: boolean }
  | { kind: 'refuse'; text: string };

export function decideMcpCall(input: McpGateInput): McpGateDecision {
  const { tool, args } = input;
  const plan = buildPlan({
    server: tool.server,
    tool: tool.name,
    label: effectiveLabel(tool),
    schema: tool.inputSchema,
    arguments: args,
  });
  const label = callLabel(plan);
  // Casper's walk() stops silently past MAX_DEPTH, so a deeper confirm or dry_run switch would go
  // unseen: refuse rather than guess.
  if (argsDepth(args) > MAX_DEPTH) return { kind: 'refuse', text: TOO_DEEP };
  const skipped = aiConfirm(args).length + previewSwitchedOff(args).length > 0;
  const js = tool.preset === JUNOS_PRESET ? junosShow(tool.name, args) : 'n/a';
  const router = plan.router;

  // 6. A read-only login (the server's own access_check said so).
  if (tool.access === 'read-only' && rank(label) > rank('diagnostic')) {
    return { kind: 'refuse', text: readOnlyLoginText(tool.server) };
  }
  // 7. Writes off: refused before the box, like Casper's refuseByPolicy on the plan label.
  if (tool.writes === 'off') {
    if (tool.preset === JUNOS_PRESET && (JUNOS_COMMIT_TOOLS.has(tool.name) || js === 'not-show')) {
      return { kind: 'refuse', text: JUNOS_WRITES_OFF_TEXT };
    }
    if (writesOffHides(label, tool.name) || writesOffHides(plan.label, tool.name)) {
      return { kind: 'refuse', text: writesOffText(tool.server) };
    }
    // A router must not reach a hidden tool by a name GreenCLI can't judge.
    if (router && (plan.routerUnclear || plan.routed.some((call) => !readNamed(call.name)))) {
      return { kind: 'refuse', text: writesOffText(tool.server) };
    }
  }
  // 8. The Read-only Auditor: reads and diagnostic checks only (a check still asks), plus Junos plain
  //    shows (which still ask without the opt-in).
  const junosShowOk = js === 'all-show' && tool.name !== 'execute_junos_pfe_command';
  if (input.readOnlyAgent && (skipped || (rank(label) > rank('diagnostic') && !junosShowOk))) {
    return { kind: 'refuse', text: AUDITOR_REFUSAL };
  }

  if (
    js === 'all-show' &&
    tool.name !== 'execute_junos_pfe_command' &&
    tool.showOptIn === true &&
    !skipped &&
    plan.routed.length === 0 &&
    !plan.routerUnclear
  ) {
    return { kind: 'run', label, why: 'junos-show' };
  }
  // A router call always asks, whatever its label.
  if (rank(label) < rank(ASK_AT) && !skipped && !router) return { kind: 'run', label, why: 'read' };

  const sessionOk =
    label === 'external-action' &&
    readNamed(tool.name) &&
    !skipped &&
    !router &&
    plan.routed.length === 0 &&
    !plan.routerUnclear;
  if (sessionOk && input.allowedForSession) return { kind: 'run', label, why: 'session' };

  return {
    kind: 'ask',
    label,
    plan,
    notes: approvalNotes(plan, tool, label),
    choices: sessionOk ? ['no', 'once', 'session'] : ['no', 'once'],
    danger: rank(label) >= rank('write'),
  };
}

/** The Read-only Auditor only sees tools the server marks read-only or diagnostic (a check such as
 *  ping, which still asks), and the Junos command tools, which it may use for plain show commands. */
export function visibleToReadOnlyAgent(tool: McpToolInfo): boolean {
  if (rank(effectiveLabel(tool)) <= rank('diagnostic')) return true;
  return tool.preset === JUNOS_PRESET && JUNOS_SHOW_TOOLS.has(tool.name);
}

/** "a", "a and b", "a, b and c" */
function joinWords(words: string[]): string {
  if (words.length <= 1) return words.join('');
  return `${words.slice(0, -1).join(', ')} and ${words[words.length - 1]}`;
}

/** The key at the end of a walk() path ("calls[0].arguments.force" -> "force"). */
function lastKey(path: string): string {
  return path.slice(path.lastIndexOf('.') + 1);
}

const LABEL_NOTES: Partial<Record<CapabilitySafety, string>> = {
  diagnostic: "The server says this tool runs a check, but doesn't say it only reads",
  'external-action': "The server doesn't say this tool only reads, so it might change something",
  write: 'This tool can change settings',
  exec: 'This tool runs commands',
  destructive: 'This tool can delete, restart or disconnect things',
};

/** The notes in the approval box, in order. Every name goes through showName. */
export function approvalNotes(plan: ApprovalPlan, tool: McpToolInfo, label: CapabilitySafety): string[] {
  const notes: string[] = [];
  const labelNote = LABEL_NOTES[label];
  if (labelNote) notes.push(labelNote);

  const through = showName(tool.name);
  const routed = plan.routed.map((call) => showName(call.name));
  if (routed.length === 1 && !plan.routerUnclear) {
    notes.push(`Runs ${routed[0]} through ${through}`);
  } else if (routed.length > 0) {
    const unseen = plan.routerUnclear ? ", and tools GreenCLI can't see" : '';
    notes.push(`Runs ${routed.length} tool${routed.length === 1 ? '' : 's'} through ${through}: ${routed.join(', ')}${unseen}`);
  } else if (plan.routerUnclear) {
    notes.push(`Runs a tool GreenCLI can't see, through ${through}`);
  }

  const confirms = [...new Set(aiConfirm(plan.arguments).map((path) => showName(lastKey(path))))];
  if (confirms.length) {
    notes.push(`The AI set ${joinWords(confirms)} by itself. That can skip the server's own check, so it runs only if you say Yes`);
  }
  const previews = [...new Set(previewSwitchedOff(plan.arguments).map((path) => showName(lastKey(path))))];
  if (previews.length) {
    notes.push(`The AI turned off ${joinWords(previews)}, so this makes the change instead of only showing it`);
  }

  notes.push(...presetNotes(tool.preset, tool.name));
  if (
    tool.preset === JUNOS_PRESET &&
    tool.name !== 'execute_junos_pfe_command' &&
    tool.showOptIn !== true &&
    junosShow(tool.name, plan.arguments) === 'all-show'
  ) {
    notes.push(
      'Plain show command. To run these without asking, turn on "Run plain show commands without asking" ' +
        'for this server in Settings → MCP Servers'
    );
  }
  return notes;
}
