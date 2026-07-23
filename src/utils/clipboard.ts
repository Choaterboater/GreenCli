import { writeText as tauriWriteText, readText as tauriReadText } from '@tauri-apps/api/clipboard';

/**
 * Clipboard access that actually works inside Tauri's webviews.
 *
 * navigator.clipboard is unreliable across the three platform webviews
 * (WKWebView restricts readText, WebView2 gates it behind a permission
 * prompt, older WebKitGTK lacks parts of the async API), so the Tauri
 * clipboard API — which talks to the OS clipboard directly — is the
 * primary path, with the web API and a hidden-textarea execCommand as
 * fallbacks for dev-in-browser contexts.
 */
export async function copyText(text: string): Promise<boolean> {
  try {
    await tauriWriteText(text);
    return true;
  } catch {
    /* not running under Tauri, or allowlist rejected — fall through */
  }
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    /* clipboard API unavailable/denied — fall through */
  }
  try {
    const prevFocus = document.activeElement as HTMLElement | null;
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.setAttribute('readonly', '');
    ta.style.position = 'fixed';
    ta.style.top = '-1000px';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand('copy');
    document.body.removeChild(ta);
    prevFocus?.focus?.();
    return ok;
  } catch {
    return false;
  }
}

export async function readClipboardText(): Promise<string | null> {
  try {
    const text = await tauriReadText();
    if (text != null) return text;
  } catch {
    /* not running under Tauri, or allowlist rejected — fall through */
  }
  try {
    return await navigator.clipboard.readText();
  } catch {
    return null;
  }
}
