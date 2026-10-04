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

// Is a key event's target inside a dialog or an open menu, or the button of an
// open menu? Keys pressed there (Escape, Enter, arrows) belong to it and must
// not be handed to the terminal.
export function inPopup(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null;
  return !!el?.closest?.(
    '[aria-modal="true"], [role="dialog"], [role="menu"], .modal-backdrop, [aria-haspopup][aria-expanded="true"]'
  );
}
