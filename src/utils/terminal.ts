import { invoke } from '@tauri-apps/api/tauri';

/** Small async delay. */
export const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Strip ANSI / VT control sequences from captured terminal output. */
export function stripAnsi(text: string): string {
  return text
    .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, '') // OSC
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '')             // CSI
    .replace(/\x1b[@-Z\\-_]/g, '')                        // two-byte ESC
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, '')    // other controls
    .replace(/\r\n?/g, '\n');
}

/** True if the text contains embedded ANSI escape sequences (terminal capture). */
export function hasAnsi(text: string): boolean {
  return /\x1b\[/.test(text.slice(0, 20_000));
}

/**
 * Send `command` to `sessionId` and poll the backend output buffer until it
 * stops growing (output settled) or the timeout is reached (~6 s).
 * Returns the new output since `before`, ANSI-stripped and trimmed.
 */
export async function sendAndCapture(
  sessionId: string,
  command: string,
): Promise<string> {
  const beforeText = await invoke<string>('get_terminal_output', { sessionId });
  const before = beforeText.length;
  // Anchor on the tail of the pre-command buffer so we can still locate the new
  // output even if the backend trims the buffer mid-capture (see delta recovery).
  const anchor = beforeText.slice(-200);
  await invoke('send_data', { sessionId, data: command + '\r' });

  // Don't seed stability with `before`: a slow device that hasn't responded yet
  // would otherwise look "stable" and bail in ~800ms with empty output. Wait for
  // the buffer to first grow past `before`, then count stability on the new output.
  let lastLen = -1;
  let stable = 0;
  let grew = false;
  let buf = beforeText;
  for (let i = 0; i < 15; i++) {
    await sleep(400);
    buf = await invoke<string>('get_terminal_output', { sessionId });
    if (!grew) {
      if (buf.length > before) {
        grew = true;
        lastLen = buf.length;
      }
      continue; // keep waiting until the device first responds
    }
    if (buf.length === lastLen) {
      if (++stable >= 2) break;
    } else {
      stable = 0;
      lastLen = buf.length;
    }
  }

  // Recover only the new output. Prefer slicing after the pre-command anchor — this
  // survives a backend tail-trim that would make a length-based slice return stale,
  // pre-command content. Fall back to length slicing, then to the whole tail.
  let delta: string;
  const aIdx = anchor ? buf.lastIndexOf(anchor) : -1;
  if (aIdx >= 0) {
    delta = buf.slice(aIdx + anchor.length);
  } else if (buf.length >= before) {
    delta = buf.slice(before);
  } else {
    delta = buf; // buffer trimmed and the anchor scrolled off — best effort
  }
  return stripAnsi(delta).trim();
}
