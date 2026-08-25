// ─── Write-confirmation gate for AI-issued device actions ───
//
// The AI tool loop is reachable by prompt injection: device output (LLDP
// neighbor names, banners), MCP-server responses, and REST payloads are fed
// back to the model as tool results, so injected text could drive a destructive
// command with no user interaction. The manual paths already confirm writes
// (ApiExplorer confirms non-GET, Terminal confirms multi-line pastes); this is
// the code-level equivalent for the AI path. Obvious reads pass with no dialog
// to keep the diagnostic path fast; everything else is confirmed (fail-safe).
export const AI_READ_ONLY_CMD =
  /^\s*(do\s+)?(sh(ow)?|disp(lay)?|get|ping|traceroute|tracert|monitor|dir|more|less|cat|tail|head|echo|whoami|who|uptime|date|\?)\b/i;
export const AI_CONFIG_ENTER = /^\s*conf(ig(ure)?)?\b/i;
export const AI_DESTRUCTIVE_CMD =
  /\b(write|erase|delete|clear|reload|reboot|boot|commit|rollback|copy|format|factory-reset|factory-default|zeroize|request\s+system|install|upgrade)\b/i;
export const AI_DANGER_CMD = /\b(erase|delete|reload|reboot|format|factory|write|zeroize|rollback)\b/i;

/** Heuristic: does this (possibly multi-line) command modify device state? */
export function aiIsWriteCommand(cmd: string): boolean {
  return cmd.split(/\r?\n/).some((line) => {
    const c = line.trim();
    if (!c) return false;
    if (AI_CONFIG_ENTER.test(c) || AI_DESTRUCTIVE_CMD.test(c)) return true;
    if (AI_READ_ONLY_CMD.test(c)) return false;
    return true; // unknown verb (set/no/interface/vlan/…): confirm to be safe
  });
}

/** MCP tool names are opaque, so confirm anything that looks like a write. */
export function aiMcpLooksWrite(tool: string): boolean {
  // Verbs are matched as snake_case/kebab SEGMENTS: a plain `\b` suffix never
  // fires between word characters, so `delete_device` used to slip through.
  const looksRead =
    /(^|[_\s-])(get|list|read|show|describe|search|find|query|fetch|status|inspect)(?=$|[_\s-])/i.test(
      tool
    );
  const looksWrite =
    /(^|[_\s-])(write|create|update|delete|remove|set|put|post|patch|reboot|erase|apply|deploy|provision|add|modify|enable|disable|move|rename)(?=$|[_\s-])/i.test(
      tool
    );
  return looksWrite && !looksRead;
}
