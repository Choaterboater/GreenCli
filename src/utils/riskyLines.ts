// One verdict per config or CLI line, shared by every check in GreenCLI: the AI's write gate, sends
// to several devices, and the Config Editor's squiggles. No Tauri imports, so Casper can copy it.
//
//   read       only looks (show, display, ping …), with no file-writing pipe and no command chain
//   config     a plain config line (interface 1/1/1, description …): not a change verb by itself
//   change     changes or saves config (configure, write memory, commit, no …, copy …)
//   dangerous  can cause an outage or lose data (reload, shutdown, erase, delete interfaces …)

import { AI_CONFIG_ENTER, AI_DESTRUCTIVE_CMD, AI_WRITE_PIPE, isReadLine, LINE_BREAK } from './aiGating';

export type LineKind = 'read' | 'config' | 'change' | 'dangerous';

// ─── Dangerous-line classifier ───

// Whole-token match: `-` counts as part of a word, so `shutdown-window` or
// `reload-timer` in a name/description don't match. (No lookbehind — older
// macOS WebKit rejects it and the whole editor would fail to load.)
const T = '(?:^|[^\\w-])';
const E = '(?![\\w-])';
// An optional `do ` prefix (exec command run from config mode).
const DO = '^\\s*(?:do\\s+)?';

// Each pattern with what it does to the device, in plain words, for the
// editor's squiggles and the Send dialog.
const DANGER_RULES: Array<{ re: RegExp; reason: string }> = [
  // Software and state: installing or upgrading software, rolling back to an older config, clearing
  // live sessions, tables or counters. (`rollback 0` / a bare `rollback` only drop uncommitted edits.)
  // (Not the Linux file-copy tool: `install -m 644 a b`.)
  { re: new RegExp(`${DO}(?:install|upgrade)${E}(?!\\s+-)`, 'i'), reason: 'installs or upgrades software' },
  { re: /^\s*(?:do\s+)?request\s+system\s+software\s+(?:add|install|rollback)\b/i, reason: 'installs or rolls back software' },
  { re: /^\s*rollback\s+(?:[1-9]\d*|rescue)\b/i, reason: 'loads an older config' },
  // (Not a bare `clear` or `clear screen`.)
  { re: /^\s*(?:do\s+)?clear\s+(?!screen\b)\S/i, reason: 'clears live sessions, tables or counters' },
  // Wiping storage, deleting files from a device filesystem (flash:, nvram:), factory resets.
  { re: new RegExp(`${DO}format${E}`, 'i'), reason: 'formats storage' },
  { re: /^\s*(?:do\s+)?delete\s+(?:\/\S+\s+)*[\w-]+:/i, reason: 'deletes files from the device' },
  { re: new RegExp(`${T}factory-(?:reset|default)${E}`, 'i'), reason: 'resets the device to factory defaults' },
  // Wipe / factory-reset / reboot.
  { re: new RegExp(`${DO}erase${E}`, 'i'), reason: 'erases the config or storage' },
  { re: new RegExp(`${DO}write\\s+erase${E}`, 'i'), reason: 'erases the saved config' },
  { re: new RegExp(`${T}zeroize${E}`, 'i'), reason: 'wipes the device back to factory state' },
  // `reload cancel` just cancels a scheduled reload.
  { re: new RegExp(`${DO}reload${E}(?!\\s+cancel)`, 'i'), reason: 'reboots the switch' },
  {
    re: new RegExp(`${DO}(?:sudo\\s+)?(?:systemctl\\s+)?(?:request\\s+system\\s+)?(?:reboot|halt|power-?off|poweroff)${E}`, 'i'),
    reason: 'reboots or powers off the device',
  },
  // AOS-CX reboots with `boot system`.
  { re: new RegExp(`${DO}boot\\s+system${E}`, 'i'), reason: 'reboots the switch' },
  // Junos: a bare `delete` wipes the whole candidate config; `load override`
  // / `load factory-default` replace it.
  { re: /^\s*delete\s*$/i, reason: 'deletes the whole candidate config' },
  { re: /^\s*delete\s+configuration\b/i, reason: 'deletes the whole candidate config' },
  { re: /^\s*load\s+(?:override|factory-default)\b/i, reason: 'replaces the whole config' },
  // Deleting the whole system hierarchy, or the parts that carry management
  // access (SSH, logins, root password). Other `delete system …` is routine.
  {
    re: /^\s*delete\s+system(?:\s*$|\s+(?:services|login|root-authentication)\b)/i,
    reason: 'removes management access (SSH, logins or the root password)',
  },
  // Taking something down. `shutdown` counts only when the line isn't a
  // `no …` negation: `no shutdown` (and `no ip ospf shutdown`) bring things
  // UP, and flagging them buried the real warnings.
  { re: new RegExp(`^(?!\\s*no\\s).*${T}shutdown${E}`, 'i'), reason: 'shuts it down' },
  // Junos equivalents of shutdown.
  { re: /^\s*set\s+interfaces\s+\S+(?:\s+unit\s+\S+)?\s+disable\s*$/i, reason: 'disables the interface' },
  { re: /^\s*deactivate\s+interfaces\b/i, reason: 'deactivates interfaces' },
  // Junos: deleting interfaces or VLANs.
  { re: /^\s*delete\s+(?:interfaces|vlans)\b/i, reason: 'removes interfaces or VLANs' },
  // Removing interfaces, VLANs, or a whole routing process.
  { re: /^\s*no\s+interface\b/i, reason: 'removes the interface' },
  { re: /^\s*no\s+vlan\s+\d/i, reason: 'removes the VLAN' },
  { re: /^\s*no\s+router\s+\S+/i, reason: 'removes the routing process' },
  // Overwriting a config from elsewhere. `copy running-config startup-config`
  // is the normal SAVE step, so it is NOT flagged — same as Junos `commit`,
  // the required apply step: flagging those trained people to ignore the
  // warning entirely.
  {
    re: /^\s*copy\s+(?!run(?:ning-config)?\b)(?:\S+\s+){1,3}(?:start(?:up-config)?|run(?:ning-config)?)\b/i,
    reason: 'overwrites the config from another copy',
  },
];

// Free text (descriptions, names, banners) can say anything — `description
// shutdown after cutover` is not a shutdown. Blank it out before matching.
const FREE_TEXT = /(^|[^\w-])(description|name|alias|banner(?:\s+\S+)?)(?![\w-])\s+.*$/i;

/** What a dangerous config line does, in plain words ("reboots the switch"),
 *  or undefined when the line is not dangerous. */
export function dangerReason(line: string): string | undefined {
  const cmd = blankFreeText(line);
  return DANGER_RULES.find((rule) => rule.re.test(cmd))?.reason;
}

/** The line with quoted strings and free text (descriptions, names, banners) blanked out. */
export function blankFreeText(line: string): string {
  return line.replace(/"[^"]*"|'[^']*'/g, '""').replace(FREE_TEXT, '$1$2');
}

/** True when a config line would erase, reboot, shut down, or remove something. */
export function isDangerousLine(line: string): boolean {
  return dangerReason(line) !== undefined;
}

// Verbs the AI lists don't cover: `no …` undoes config, `shutdown` takes a port (or the box) down.
const EXTRA_CHANGE = /^\s*(do\s+)?(no\s+\S|shut(down)?\b|halt\b|power-?off\b)/i;

/** What one line does, with the plain-words reason when it is dangerous. */
export function classifyLine(line: string): { kind: LineKind; reason?: string } {
  const raw = line.trim();
  // A read first: a risky word in a read's filter (`show int | include shutdown`) is just text.
  if (!raw || isReadLine(raw)) return { kind: 'read' };
  const reason = dangerReason(raw);
  if (reason) return { kind: 'dangerous', reason };
  const cmd = blankFreeText(raw);
  if (AI_CONFIG_ENTER.test(cmd) || AI_DESTRUCTIVE_CMD.test(cmd) || AI_WRITE_PIPE.test(raw) || EXTRA_CHANGE.test(cmd)) return { kind: 'change' };
  return { kind: 'config' };
}

/** True when any line of a (possibly multi-line) command is dangerous, each command of a chain
 *  (`show ver; reload`, `a && b`, `a & b`) judged on its own. */
export function commandIsDangerous(text: string): boolean {
  return text.split(LINE_BREAK).flatMap((line) => line.split(/;|&&|\|\||&/))
    .some((part) => classifyLine(part).kind === 'dangerous');
}
