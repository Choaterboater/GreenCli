// Is a key event's target a place the user types text? The app hands keys
// pressed anywhere else back to the terminal, so a miss here sends the keys to
// the device. In a Chromium WebView (WebView2 on Windows) Monaco types into a
// plain div through the EditContext API, not a textarea: without the last two
// checks, typing in the Config Editor went to the switch.

export function isTextEntry(target: EventTarget | null): boolean {
  const el = target as (HTMLElement & { editContext?: unknown }) | null;
  if (!el || typeof el.tagName !== 'string') return false;
  if (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable) return true;
  // EditContext: the element itself takes the typed text.
  if (el.editContext) return true;
  // Anything focused inside a Monaco editor is the editor's own input.
  return !!el.closest?.('.monaco-editor');
}
