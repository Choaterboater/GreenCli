// Risk check for commands a person sends to several devices at once (Bulk
// Runner, the multi-send bar). Reuses the AI write gate's verb lists but NOT
// its fail-safe "unknown verb = write" rule: here a human typed the line, and
// flagging every `interface 1/1/1` or `description …` would train people to
// click straight through the dialog. Only verbs that change, save, or disrupt
// the box count.

import {
  AI_CONFIG_ENTER,
  AI_DESTRUCTIVE_CMD,
  AI_READ_ONLY_CMD,
  CONTROL_CHARS,
  LINE_BREAK,
} from './aiGating';

// Verbs the AI lists don't cover: `no …` undoes config, `shutdown` takes a port
// (or the box) down.
const EXTRA_RISKY = /^\s*(do\s+)?(no\s+\S|shut(down)?\b|halt\b|power-?off\b)/i;

function isRiskyLine(line: string): boolean {
  const c = line.trim();
  if (!c) return false;
  if (AI_READ_ONLY_CMD.test(c)) return false;
  return AI_CONFIG_ENTER.test(c) || AI_DESTRUCTIVE_CMD.test(c) || EXTRA_RISKY.test(c);
}

/** True when a CLI command looks like it changes device state (reload, write
 *  memory, configure, commit, `no …`, shutdown, …). Reads (show/display/ping…)
 *  are never risky, even when they mention a risky word in a filter. Every
 *  line counts, a bare `\r` included, and control characters (backspace,
 *  Ctrl-Z, …) are risky: the device acts on them, so "show" may not be what runs. */
export function isRiskyCommand(text: string): boolean {
  if (CONTROL_CHARS.test(text)) return true;
  return text.split(LINE_BREAK).some(isRiskyLine);
}

/** The risky lines of a (possibly multi-line) command, trimmed, in order. */
export function riskyLines(text: string): string[] {
  return text
    .split(LINE_BREAK)
    .map((l) => l.trim())
    .filter(isRiskyCommand);
}

/** "sw1, sw2, sw3 and 4 more" — keeps a confirm dialog readable at scale. */
export function listNames(names: string[], max = 6): string {
  if (names.length <= max) return names.join(', ');
  return `${names.slice(0, max).join(', ')} and ${names.length - max} more`;
}
