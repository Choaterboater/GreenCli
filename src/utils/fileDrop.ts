import { getCurrentWebview } from '@tauri-apps/api/webview';
import type { UnlistenFn } from '@tauri-apps/api/event';
import { isTauri } from './tauri';

export interface FileDropHandlers {
  /** Files are being dragged over this window. */
  onEnter?: () => void;
  /** The drag left the window, or was cancelled. */
  onLeave?: () => void;
  /** Files were dropped on this window: their full paths. */
  onDrop?: (paths: string[]) => void;
}

/**
 * Listen for files dragged from the desktop onto THIS window (a drop on a
 * pop-out goes only to that pop-out). Resolves to the function that stops
 * listening. Outside the app it does nothing.
 */
export async function listenFileDrops(handlers: FileDropHandlers): Promise<UnlistenFn> {
  if (!isTauri) return () => {};
  return getCurrentWebview().onDragDropEvent((event) => {
    const p = event.payload;
    switch (p.type) {
      case 'enter':
      case 'over':
        handlers.onEnter?.();
        break;
      case 'leave':
        handlers.onLeave?.();
        break;
      case 'drop':
        handlers.onDrop?.(p.paths ?? []);
        break;
    }
  });
}
