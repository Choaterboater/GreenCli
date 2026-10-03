// Work that must finish before GreenCLI closes itself (Restart to update).
// A window close or reload has `beforeunload`; an update restart doesn't wait
// for it, so anything that saves late (the debounced vault save) registers
// here too. Long jobs that must not be cut off (a Change Job, a bulk run, a
// Config Editor send, an SFTP upload or download) hold the exit while they run.

type ExitHandler = () => void | Promise<unknown>;

const handlers = new Set<ExitHandler>();
const holds = new Map<number, string>();
let holdSeq = 0;

/** Run `fn` before the app closes itself. Returns a function that removes it. */
export function registerBeforeExit(fn: ExitHandler): () => void {
  handlers.add(fn);
  return () => {
    handlers.delete(fn);
  };
}

/**
 * Run every registered handler and wait for all of them. A handler that
 * throws or rejects is logged and doesn't stop the others.
 */
export async function runBeforeExit(): Promise<void> {
  await Promise.all(
    [...handlers].map(async (fn) => {
      try {
        await fn();
      } catch (e) {
        console.warn('A save before closing failed:', e);
      }
    }),
  );
}

/**
 * Keep the app from closing itself while some work runs. `what` says what is
 * running, e.g. "A Change Job is running." Returns the function that lets go.
 */
export function holdExit(what: string): () => void {
  const id = ++holdSeq;
  holds.set(id, what);
  return () => {
    holds.delete(id);
  };
}

/** What is holding the exit right now (empty when nothing is). */
export function exitHolds(): string[] {
  return [...new Set(holds.values())];
}
