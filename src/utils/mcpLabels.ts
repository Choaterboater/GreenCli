// Copied from casper src/capabilities/labels.ts @ ad678b6. Do not edit here: change Casper, re-copy.
// Changed here: the two type-only imports point at ./mcpTypes.
// ---- casper source below ----
/**
 * Safety labels for MCP tools.
 *
 * Rule: a label can only get stricter than what the server says, and never looser than the label
 * Casper 0.2.14 gave the same tool (`legacyLabel`, kept word for word below). Nothing here can make a
 * tool read-only: only the server's own readOnlyHint can, and only when the name agrees. Words in a
 * tool name, `_meta["casper/safety"]` and presets may add approvals; they never remove one.
 *
 * Word lists: the network words (bounce, reload, halt, deauth, zeroize, ...) are Casper's own. The
 * general delete / change / run / read families were checked against, and partly taken from, the
 * actlint vocabulary (package actlint 0.3.0, vocabulary 0.5.0, by Formael, Apache-2.0,
 * https://github.com/formael/actlint). actlint ships no NOTICE file; its credit is in
 * THIRD_PARTY_NOTICES.txt.
 */
import type { CapabilitySafety, MCPTool } from "./mcpTypes";

export type { CapabilitySafety };

/** Least to most strict. A higher rank never runs with fewer approvals than a lower one. */
export const SAFETY_RANK: Readonly<Record<CapabilitySafety, number>> = Object.freeze({
  read: 0, diagnostic: 1, "external-action": 2, write: 3, exec: 4, destructive: 5,
});

export function isSafetyLabel(value: unknown): value is CapabilitySafety {
  return typeof value === "string" && Object.hasOwn(SAFETY_RANK, value);
}

/** The strictest of the given labels; `read` when none are given. */
export function strictest(...labels: CapabilitySafety[]): CapabilitySafety {
  let result: CapabilitySafety = "read";
  for (const label of labels) if (SAFETY_RANK[label] > SAFETY_RANK[result]) result = label;
  return result;
}

/** Words that change or break something on a device or in a product. Anywhere in a name, always. */
export const DESTRUCTIVE_WORDS: ReadonlySet<string> = new Set([
  // Casper 0.2.14 and network actions.
  "delete", "destroy", "remove", "reset", "reboot", "wipe", "bounce", "reload", "restart", "halt", "shutdown",
  "disconnect", "deauth", "deauthenticate", "rollback", "erase", "zeroize", "purge", "factory", "kick", "upgrade",
  "downgrade", "powercycle", "flush",
  // actlint verb.delete.
  "drop", "truncate", "clear", "revoke", "terminate", "uninstall",
]);
/** Words that run commands. Anywhere in a name, always. */
export const EXEC_WORDS: ReadonlySet<string> = new Set([
  "exec", "execute", "shell", "run", "command", "cli",
  // actlint verb.execute (without invoke, deploy, apply and compile, which are handled elsewhere).
  "eval", "spawn",
]);
/** Words that make a change. They tighten unless the name starts with a read word or ends with a read noun. */
export const WRITE_WORDS: ReadonlySet<string> = new Set([
  "create", "update", "set", "write", "deploy", "commit", "apply", "push", "provision", "assign", "unassign", "add",
  "enable", "disable", "rename", "move", "archive", "acknowledge", "rotate", "trigger", "save", "install", "modify",
  "edit", "change", "replace", "configure", "manage", "build", "migrate", "register", "unregister", "claim",
  "unclaim", "block", "unblock", "quarantine",
  // actlint verb.create, verb.mutate and verb.send.
  "insert", "append", "upload", "submit", "import", "ingest", "clone", "copy", "duplicate", "patch", "put",
  "toggle", "approve", "cancel", "overwrite", "upsert", "sync", "synchronize", "persist", "restore", "merge",
  "activate", "deactivate", "send", "post", "publish", "notify", "share", "broadcast", "transfer",
]);
/** Words that only look at something. */
export const READ_WORDS: ReadonlySet<string> = new Set([
  "get", "list", "show", "find", "search", "describe", "read", "fetch", "query", "lookup", "check", "verify",
  "preview", "plan", "inspect", "locate", "status",
  // actlint verb.read.
  "view", "retrieve", "count", "exists",
]);
/** A change word just before one of these endings names what is read (glp_write_status reads the
 * write status). Only that one word is skipped: edgeconnect_set_zone_firewall_status is still a change. */
export const READ_NOUN_ENDINGS: ReadonlySet<string> = new Set(["status", "state", "diff", "preview", "history", "count"]);

/**
 * Exact tool names where a destructive, run or change word is a noun, not an action. Only the listed
 * words are skipped, only for that exact name, and `nameLabel` never goes below 0.2.14, so this cannot
 * make any tool looser than Casper 0.2.14 made it. Taken from the read-only tools in hpe-networking-mcp.
 */
export const NOUN_USES: ReadonlyMap<string, readonly string[]> = new Map([
  ["aos8_get_migration_run", ["run"]],
  ["aos8_preview_migration_run", ["run"]],
  ["aos8_verify_migration_run", ["run"]],
  ["aos8_plan_migration_rollback", ["rollback"]],
  ["get_config_rollback_status", ["rollback"]],
  ["get_glp_block_storage_volume", ["block"]],
  ["get_glp_block_storage_volumes", ["block"]],
  ["get_glp_block_storage_hosts", ["block"]],
  ["get_glp_service_provision", ["provision"]],
  ["get_glp_service_manager_provision", ["provision"]],
]);

/** Generic dispatchers that can run any tool. Judged as destructive, as in 0.2.14. */
export const GENERIC_DISPATCHERS: ReadonlySet<string> = new Set(["invoke_tool", "invoke_tools_batch"]);

/** Whole lowercase words: snake_case, kebab-case, dots, spaces and camelCase (rebootDevice -> reboot, device). */
export function toolWords(name: string): string[] {
  return name
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
}

/**
 * What the words in a tool name say, judged by the word lists alone. This is the honest reading of the
 * name (glp_write_status reads a status, so it says `read`), for checks such as "does this server's
 * read-only label look right". Casper does not approve calls with it; it uses `nameLabel`.
 */
export function wordLabel(name: string): CapabilitySafety {
  const skipped = new Set(NOUN_USES.get(name) ?? []);
  const words = toolWords(name).filter((word) => !skipped.has(word));
  if (words.some((word) => DESTRUCTIVE_WORDS.has(word))) return "destructive";
  if (words.some((word) => EXEC_WORDS.has(word))) return "exec";
  const firstAction = words.find((word) => READ_WORDS.has(word) || WRITE_WORDS.has(word));
  const readFirst = firstAction !== undefined && READ_WORDS.has(firstAction);
  const describing = words.length >= 3 && READ_NOUN_ENDINGS.has(words.at(-1)!) ? words.length - 2 : -1;
  if (!readFirst && words.some((word, index) => index !== describing && WRITE_WORDS.has(word))) return "write";
  return "read";
}

/** The name words Casper 0.2.14 acted on (the name part of its safety()). */
export function legacyNameLabel(name: string): CapabilitySafety {
  if (GENERIC_DISPATCHERS.has(name)) return "destructive";
  const spaced = name.replaceAll("_", " ");
  if (/\b(delete|destroy|remove|reset|reboot|wipe)\b/.test(spaced)) return "destructive";
  if (/\b(exec|execute|shell|run)\b/.test(spaced)) return "exec";
  if (/\b(create|update|set|write|deploy)\b/.test(spaced)) return "write";
  return "read";
}

/**
 * The label a tool name forces, whatever the server says. Never looser than 0.2.14, so a name 0.2.14
 * asked about (glp_write_status, aos8_get_migration_run) still asks. Also used for the real tool behind
 * a router call, where Casper has no annotations to go on.
 */
export function nameLabel(name: string): CapabilitySafety {
  return strictest(wordLabel(name), legacyNameLabel(name));
}

/** Casper 0.2.14's broker.ts safety(), unchanged. Every new label is at least this strict. */
export function legacyLabel(tool: Pick<MCPTool, "name" | "annotations" | "_meta">): CapabilitySafety {
  if (tool.name === "invoke_tool" || tool.name === "invoke_tools_batch" || tool.annotations?.destructiveHint === true) return "destructive";
  if (/\b(delete|destroy|remove|reset|reboot|wipe)\b/.test(tool.name.replaceAll("_", " "))) return "destructive";
  if (/\b(exec|execute|shell|run)\b/.test(tool.name.replaceAll("_", " "))) return "exec";
  if (/\b(create|update|set|write|deploy)\b/.test(tool.name.replaceAll("_", " "))) return "write";
  const declared = tool._meta?.["casper/safety"];
  if (typeof declared === "string" && ["diagnostic", "write", "destructive", "exec", "external-action"].includes(declared)) return declared as CapabilitySafety;
  return tool.annotations?.readOnlyHint === true ? "read" : "external-action";
}

/** What the server's annotations claim. Only readOnlyHint: true can give `read`. */
export function annotationLabel(tool: Pick<MCPTool, "annotations">): CapabilitySafety {
  if (tool.annotations?.destructiveHint === true) return "destructive";
  return tool.annotations?.readOnlyHint === true ? "read" : "external-action";
}

/**
 * The label Casper uses for a tool: the strictest of the server's annotations, the name words,
 * `_meta["casper/safety"]` and the 0.2.14 label. `_meta` may relax one thing only: an unannotated
 * tool (`external-action`) marked `diagnostic` is `diagnostic`, as in 0.2.14.
 */
export function toolLabel(tool: Pick<MCPTool, "name" | "annotations" | "_meta">): CapabilitySafety {
  const declared = tool._meta?.["casper/safety"];
  const meta = isSafetyLabel(declared) && declared !== "read" ? declared : undefined;
  const label = strictest(annotationLabel(tool), nameLabel(tool.name), legacyLabel(tool), ...(meta ? [meta] : []));
  if (label === "external-action" && meta === "diagnostic") return "diagnostic";
  return label;
}
