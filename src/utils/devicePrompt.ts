// Read the device's CURRENT prompt from the tail of terminal output: its
// hostname and whether it is in configuration mode. Feeds the tab label
// (hostname) and the amber CONFIG badge — a reminder that what you type next
// changes the running config.
//
// Only the trailing line can be the prompt the device is waiting at: the
// prompt is printed without a newline after it. Output that ends in a newline,
// a pager (--More--) or a half-typed command echo ("switch# sh") matches
// nothing, and the caller keeps the last known state.

export interface DevicePrompt {
  host: string;
  configMode: boolean;
}

// Junos: `user@host> ` operational, `user@host# ` configuration (the line
// above it reads `[edit …]`). An optional `{master:0}` marker may share the
// line. Shell prompts (`root@host:RE:0% `) don't match.
// TACACS/RADIUS logins may carry their own '@', so the host is after the last one.
const JUNOS = /^(?:\{[^}]*\}\s*)?[\w.@-]+@([\w.-]{1,64})\s?([>#])$/;

// AOS-8 Mobility Conductor / controller: `(host) #`, `(host) >`,
// `(host) [mynode] #`, `(host) ^[mynode] (config) #`,
// `(host) (Virtual AP profile "guest") #`. The first group is the hostname;
// a second parenthesized group is a configuration context. `^` / `*` flag
// unsaved changes.
const AOS8 =
  /^\(([^()]{1,64})\)\s*(?:[\^*]?\[[^\]]{0,64}\]\s*)?[\^*]?(?:\(([^()]{1,80})\)\s*)?[\^*]?\s?[#>]$/;

// AOS-CX, AOS-S and Instant APs: `switch# `, `switch> `, `switch(config)# `,
// `switch(config-if)# `, AOS-S `switch(vlan-10)# ` / `switch(eth-1/1)# `,
// IAP `iap-515 (config) # `. Any context in parentheses is config mode.
const CX_STYLE = /^([A-Za-z0-9][\w.-]{0,63})\s?(?:\(([^()]{1,80})\))?\s?[#>]$/;

// A real prompt is short; anything longer is output, not worth the regexes.
const MAX_PROMPT = 160;

// `bash-5.1#` / `sh-3.2#` on a server look like `switch#` but name the shell,
// not the host.
const SHELL_NAME = /^(?:ba|z|k|c|tc|da|fi)?sh(?:-[\d.]+)?$/i;

/** Classify one line (already free of escape codes) as a device prompt. */
export function parseDevicePrompt(line: string): DevicePrompt | null {
  const text = line.trim();
  if (!text || text.length > MAX_PROMPT) return null;
  const junos = JUNOS.exec(text);
  if (junos) return { host: junos[1], configMode: junos[2] === '#' };
  const aos8 = AOS8.exec(text);
  if (aos8) return { host: aos8[1].trim(), configMode: !!aos8[2] };
  const cx = CX_STYLE.exec(text);
  if (cx && !SHELL_NAME.test(cx[1])) return { host: cx[1], configMode: !!cx[2] };
  return null;
}

// Escape sequences: CSI (colors, erase-line, cursor, bracketed paste), OSC
// (window titles) up to BEL/ST, and the short two-byte forms.
const ESCAPES = /\x1b\[[0-9;:?<=>]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)?|\x1b[()][A-Za-z0-9]|\x1b[=>78DEHMc]/g;

/**
 * The line the cursor sits on at the end of `output`, as it looks on screen:
 * escape codes removed, carriage-return redraws and backspaces applied.
 */
export function trailingLine(output: string): string {
  let line = output.slice(output.lastIndexOf('\n') + 1);
  // Bound the work: a prompt is short, and a huge unterminated line is not one.
  if (line.length > MAX_PROMPT * 4) return '';
  line = line.replace(ESCAPES, '');
  // A lone CR returns to column 0; the device then redraws the line.
  line = line.slice(line.lastIndexOf('\r') + 1);
  if (line.includes('\b')) {
    let shown = '';
    for (const ch of line) shown = ch === '\b' ? shown.slice(0, -1) : shown + ch;
    // "x\b \b" (erase a typed char) leaves a trailing blank — trimmed below.
    line = shown;
  }
  // Leftover control bytes (BEL, …) never belong to the prompt text.
  return line.replace(/[\x00-\x08\x0b-\x1f\x7f]/g, '');
}

/** The device prompt at the end of `output`, or null when the output doesn't
 *  end at a prompt (more output coming, a pager, a command being typed). */
export function detectDevicePrompt(output: string): DevicePrompt | null {
  return parseDevicePrompt(trailingLine(output));
}
