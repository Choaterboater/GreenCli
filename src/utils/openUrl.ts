import { invoke } from '@tauri-apps/api/core';
import { notify } from '../store/toastStore';
import { isTauri } from './tauri';

/**
 * Web links (a URL in terminal output or a Monaco editor, a link in an AI
 * answer, the API Explorer's docs links) open in the system browser through
 * the app's `open_url` command, which takes only http and https links. The
 * webview can't open them itself: in Tauri 2 a `window.open` or
 * `target="_blank"` link opens nothing on Windows, and never did on macOS,
 * and a plain link loads the site in place of the app.
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

let windowOpenRouted = false;

/**
 * Monaco opens a Ctrl/Cmd+clicked link (in an editor or a hover) with
 * window.open and the link text as written, which opens nothing in Tauri 2.
 * Under Tauri, an http(s) window.open goes to openWebLink instead, unchanged.
 * Monaco's registerLinkOpener is no use here: it hands over a parsed Uri,
 * which has decoded %2B, %2F, %3D, %26 …, so a presigned download link lost
 * its signature. Anything else goes to the webview's own window.open.
 * Safe to call more than once.
 */
export function routeWindowOpenToBrowser(): void {
  // In a plain browser window.open works, and openWebLink calls it.
  if (!isTauri || windowOpenRouted) return;
  windowOpenRouted = true;
  const nativeOpen = window.open.bind(window);
  window.open = (url?: string | URL, target?: string, features?: string) => {
    const href = url == null ? '' : String(url);
    if (/^https?:/i.test(href)) {
      void openWebLink(href);
      return null;
    }
    return nativeOpen(url, target, features);
  };
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
