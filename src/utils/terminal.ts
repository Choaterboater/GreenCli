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

/** Result of a send-and-capture: the new output plus whether it may be cut short. */
export interface CaptureResult {
  output: string;
  /** True when the capture hit a limit and the output may be incomplete:
   *  the ~6s settle cap was exhausted (device still streaming), the backend
   *  tail-trimmed the buffer mid-capture, or the delta is large enough that
   *  its head may have been trimmed away. */
  truncated: boolean;
}

// Past this delta size the backend's ~150KB tail trim may have cut the head of
// the captured output, so flag it as possibly truncated.
const TRUNCATION_DELTA_CAP = 128 * 1024;

// Per-session async mutex: concurrent captures on ONE session interleave their
// send/poll cycles and read each other's output. Chain each capture behind the
// previous one so a session runs at most one capture at a time. (Captures on
// DIFFERENT sessions still run concurrently — e.g. BulkRunner's pool.)
const captureChains = new Map<string, Promise<void>>();

/**
 * Send `command` to `sessionId` and poll the backend output buffer until it
 * stops growing (output settled) or the timeout is reached (~6 s).
 * Resolves with the new output since `before`, ANSI-stripped and trimmed, plus
 * a `truncated` flag (see CaptureResult).
 */
export function sendAndCapture(sessionId: string, command: string): Promise<CaptureResult> {
  const prev = captureChains.get(sessionId) ?? Promise.resolve();
  const run = prev.then(() => sendAndCaptureInner(sessionId, command));
  // Keep the chain alive even when a capture rejects, and drop the map entry
  // once this tail settles so the map can't grow with one entry per session
  // ever used.
  const tail = run.then(
    () => undefined,
    () => undefined
  );
  captureChains.set(sessionId, tail);
  void tail.then(() => {
    if (captureChains.get(sessionId) === tail) captureChains.delete(sessionId);
  });
  return run;
}

async function sendAndCaptureInner(
  sessionId: string,
  command: string,
): Promise<CaptureResult> {
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
  let settled = false;
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
      if (++stable >= 2) {
        settled = true;
        break;
      }
    } else {
      stable = 0;
      lastLen = buf.length;
    }
  }

  // Recover only the new output. A length-based slice is exact unless the
  // backend tail-trimmed the buffer mid-capture (it keeps a ~150KB tail once
  // the buffer passes 200KB, cutting the head — detectable as a changed
  // prefix or a shrunken buffer). Only then fall back to the anchor, searched
  // from the FRONT: searching from the tail breaks when the same command is
  // re-run with identical output, because the new output ends with the exact
  // anchor text and the capture comes back empty.
  let delta: string;
  const untrimmed =
    buf.length >= before && (before === 0 || buf.startsWith(beforeText.slice(0, 64)));
  if (untrimmed) {
    delta = buf.slice(before);
  } else {
    const aIdx = anchor ? buf.indexOf(anchor) : -1;
    delta = aIdx >= 0 ? buf.slice(aIdx + anchor.length) : buf; // best effort
  }
  // Never settling means the device was still streaming at the ~6s cap; a
  // trimmed buffer or a very large delta means the head may be gone.
  const truncated = !settled || !untrimmed || delta.length > TRUNCATION_DELTA_CAP;
  return { output: stripAnsi(delta).trim(), truncated };
}
