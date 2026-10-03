// Risk check for commands a person sends to several devices at once (Bulk
// Runner, the multi-send bar). Reuses the AI write gate's verb lists but NOT
// its fail-safe "unknown verb = write" rule: here a human typed the line, and
// flagging every `interface 1/1/1` or `description …` would train people to
// click straight through the dialog. Only verbs that change, save, or disrupt
// the box count.

import { CONTROL_CHARS, LINE_BREAK } from './aiGating';
import { classifyLine } from './riskyLines';

// A change or a dangerous line (riskyLines.ts). A plain config line (`interface 1/1/1`, a
// description) is not: a person typed it, and flagging it would train clicking through.
function isRiskyLine(line: string): boolean {
  const kind = classifyLine(line).kind;
  return kind === 'change' || kind === 'dangerous';
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
