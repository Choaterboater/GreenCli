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
  const before = (await invoke<string>('get_terminal_output', { sessionId })).length;
  await invoke('send_data', { sessionId, data: command + '\r' });

  let lastLen = before;
  let stable = 0;
  let buf = '';
  for (let i = 0; i < 15; i++) {
    await sleep(400);
    buf = await invoke<string>('get_terminal_output', { sessionId });
    if (buf.length === lastLen) {
      if (++stable >= 2) break;
    } else {
      stable = 0;
      lastLen = buf.length;
    }
  }

  // Guard: if the buffer was trimmed by the backend tail cap, `before` may
  // exceed the new buffer length — fall back to the full tail.
  const delta = buf.length >= before ? buf.slice(before) : buf;
  return stripAnsi(delta).trim();
}
