import { invoke } from '@tauri-apps/api/core';
import type { IBufferRange, ILinkHandler, Terminal } from 'xterm';
import { askChoice } from '../store/dialogStore';
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

/** The text a terminal link covers on screen (its range is 1-based, end inclusive). */
export function linkTextOnScreen(term: Pick<Terminal, 'buffer'>, range: IBufferRange): string {
  let text = '';
  for (let y = range.start.y; y <= range.end.y; y++) {
    const line = term.buffer.active.getLine(y - 1);
    if (!line) return '';
    const from = y === range.start.y ? range.start.x - 1 : 0;
    const to = y === range.end.y ? range.end.x : line.length;
    text += line.translateToString(false, from, to);
  }
  return text;
}

/**
 * The handler for OSC 8 hyperlinks (gcc, gh, claude… print them). Unlike a
 * plain URL, an OSC 8 link shows one text and opens a hidden address: a link
 * that reads https://portal.corp.example can open https://evil.example.
 * Hovering one puts its address (and how to open it) in the terminal's
 * tooltip, and a Ctrl/Cmd+click on one whose text is not its address asks
 * first, with the address in full. A link that shows its own address opens
 * in one click, like a plain URL. xterm's own handler asked for every link,
 * but with confirm() and window.open, which open nothing in Tauri 2.
 * `terminal` returns the terminal the handler is set on.
 */
export function terminalOscLinkHandler(
  mac: boolean,
  terminal: () => Pick<Terminal, 'buffer' | 'element'> | undefined,
): ILinkHandler {
  const howToOpen = `${mac ? 'Cmd' : 'Ctrl'}+click to open`;
  return {
    activate: (event, uri, range) => {
      if (!isLinkClick(event, mac)) return;
      const term = terminal();
      if (term && linkTextOnScreen(term, range) === uri) {
        void openWebLink(uri);
        return;
      }
      void askChoice({
        title: 'Open this link?',
        message: 'The text you clicked is not the address the link opens. It opens:',
        details: uri,
        // Cancel comes first and has focus: a stray Enter opens nothing.
        choices: [
          { value: 'cancel', label: 'Cancel' },
          { value: 'open', label: 'Open in browser', tone: 'accent' },
        ],
      }).then((choice) => {
        if (choice === 'open') void openWebLink(uri);
      });
    },
    hover: (_event, uri) => {
      const element = terminal()?.element;
      if (element) element.title = `${uri}\n${howToOpen}`;
    },
    leave: () => {
      terminal()?.element?.removeAttribute('title');
    },
  };
}
