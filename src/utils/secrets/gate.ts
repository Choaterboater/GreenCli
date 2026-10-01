// Refuse any AI tool call that carries a hidden-secret marker. The AI only
// ever saw "<secret hidden>", so a command, REST body or MCP argument that
// sends it back would write the marker over the real secret on the device.

import { LINE_MARKER, SECRET_MARKER } from './markers';

export const HIDDEN_SECRET_REFUSAL =
  `Not run: the request has ${SECRET_MARKER} in it. That marker stands in for a secret GreenCLI hid from you, ` +
  'so sending it could write the marker over the real secret. Keep the original line, or ask the user to make this change.';

/** The markers, also with other spacing or case ("<Secret  Hidden>"). */
const MARKER = /<\s*(?:secret\s+hidden|line\s+hidden\s*:\s*secret)\s*>/i;
const MAX_DEPTH = 64;

function hasMarker(value: unknown, depth: number): boolean {
  if (typeof value === 'string') {
    return value.includes(SECRET_MARKER) || value.includes(LINE_MARKER) || MARKER.test(value);
  }
  if (!value || typeof value !== 'object') return false;
  // Too deep to check is treated as carrying the marker: refuse rather than guess.
  if (depth > MAX_DEPTH) return true;
  const entries = Array.isArray(value) ? value : [...Object.keys(value), ...Object.values(value)];
  return entries.some((entry) => hasMarker(entry, depth + 1));
}

/** The refusal when a marker appears anywhere in the tool arguments (keys and
 *  values, at any depth); undefined when the call may run. */
export function hiddenSecretGate(args: unknown): string | undefined {
  return hasMarker(args, 0) ? HIDDEN_SECRET_REFUSAL : undefined;
}
