import { invoke } from '@tauri-apps/api/core';
import { notify } from '../store/toastStore';
import { isTauri } from './tauri';

/**
 * Web links (a URL in terminal output or a Monaco editor, the API Explorer's
 * docs links) open in the system browser through the app's `open_url`
 * command, which takes only http and https links. The webview can't open
 * them itself: in Tauri 2 a
 * `window.open` or `target="_blank"` link opens nothing on Windows, and never
 * did on macOS.
 */
export async function openWebLink(url: string): Promise<void> {
  if (!isTauri) {
    // vite dev / tests: a plain browser can open it.
    window.open(url, '_blank', 'noopener,noreferrer');
    return;
  }
  try {
    await invoke('open_url', { url });
  } catch (err) {
    notify.warning('Could not open link', String(err));
  }
}

/**
 * xterm activates a link on ANY mouseup over it: a plain click to focus the
 * pane or clear a selection, or a right-click. Only a left click with Ctrl
 * (Cmd on macOS) held counts, like VS Code / iTerm2.
 */
export function isLinkClick(
  event: Pick<MouseEvent, 'button' | 'ctrlKey' | 'metaKey'>,
  mac: boolean,
): boolean {
  return event.button === 0 && (mac ? event.metaKey : event.ctrlKey);
}

/** The WebLinksAddon handler: Ctrl/Cmd+click opens the URL in the browser. */
export function terminalWebLinkHandler(mac: boolean): (event: MouseEvent, uri: string) => void {
  return (event, uri) => {
    if (!isLinkClick(event, mac)) return;
    void openWebLink(uri);
  };
}
