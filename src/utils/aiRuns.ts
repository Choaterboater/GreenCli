// Stop for the AI panel: every streamed answer and CLI run has an id the
// backend registers, and Stop (ai_cancel_stream) reaches each one in flight.
// A Stop that arrives before the backend has registered the id is kept, so
// the run starts already stopped (see ai::cancel in the Rust side).
import { invoke } from '@tauri-apps/api/tauri';

// Ids are unique per page load: a reload restarts the counter, and an old
// id must never reach a run started after it.
const LOAD_ID = Math.random().toString(36).slice(2, 8);
let streamCounter = 0;

/** A new id for a streamed answer or a CLI run. */
export const nextStreamId = (): string => `aistream-${LOAD_ID}-${++streamCounter}`;

/**
 * Ids currently in flight, so Stop can abort the backend egress, which then
 * emits ai_done and lets each stream clean up its listeners. Without this,
 * Stop only stopped the UI from reading while Rust kept generating (and being
 * billed) and the event listeners leaked.
 */
export const activeStreamIds = new Set<string>();

/** Stop every answer and run in flight. */
export function cancelActiveAiStreams(): void {
  for (const id of activeStreamIds) {
    invoke('ai_cancel_stream', { streamId: id }).catch(() => {});
  }
}

/** Run `start` with a fresh id that Stop can reach until it settles. */
export async function runStoppable<T>(start: (runId: string) => Promise<T>): Promise<T> {
  const runId = nextStreamId();
  activeStreamIds.add(runId);
  try {
    return await start(runId);
  } finally {
    activeStreamIds.delete(runId);
  }
}
