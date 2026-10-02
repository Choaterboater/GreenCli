import { Window, getCurrentWindow } from '@tauri-apps/api/window';

/**
 * True inside the GreenCLI app, false in a plain browser (vite dev, tests,
 * the production smoke test). Tauri 2 sets `globalThis.isTauri` in its init
 * script, which runs before any page script, so reading it once at load is
 * enough. This is the same check as `isTauri()` in `@tauri-apps/api/core`,
 * read here directly so the many test mocks of that module (which only
 * provide `invoke`) still load.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const isTauri: boolean = !!(globalThis as any).isTauri;

/** This window's label: `main`, or `popout-<sessionId>` for a pop-out. */
export function currentWindowLabel(): string {
  return isTauri ? getCurrentWindow().label : 'main';
}

/** This window, or null outside the app. */
export function currentWindow(): Window | null {
  return isTauri ? getCurrentWindow() : null;
}

/** Bring another app window to the front. Does nothing if it isn't open. */
export async function focusWindow(label: string): Promise<void> {
  if (!isTauri) return;
  const win = await Window.getByLabel(label);
  await win?.setFocus();
}

/** Close another app window. Does nothing if it isn't open. */
export async function closeWindow(label: string): Promise<void> {
  if (!isTauri) return;
  const win = await Window.getByLabel(label);
  await win?.close();
}
