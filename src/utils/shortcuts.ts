// Keyboard shortcuts shared by the app shell, the terminal and the help text.
// The owner works on macOS AND Windows, so every chord and every hint has to be
// right on both: macOS uses ⌘ (Cmd never reaches the PTY), while Windows/Linux
// chords that would otherwise be a shell key (Ctrl+F/T/K/W …) use Ctrl+Shift.

export type Platform = 'mac' | 'windows' | 'linux';

export function detectPlatform(navPlatform: string): Platform {
  const p = navPlatform.toUpperCase();
  if (p.includes('MAC')) return 'mac';
  if (p.includes('WIN')) return 'windows';
  return 'linux';
}

export const platform: Platform = detectPlatform(
  typeof navigator !== 'undefined' ? navigator.platform : '',
);
export const isMac = platform === 'mac';

/**
 * Display a chord written in portable form ("Mod+Shift+E"). `Mod` is ⌘ on
 * macOS and Ctrl elsewhere; macOS uses the glyph style (⌘⇧E), Windows/Linux
 * the spelled-out style (Ctrl+Shift+E).
 */
export function formatChord(chord: string, p: Platform = platform): string {
  const parts = chord.split('+');
  if (p !== 'mac') return parts.map((k) => (k === 'Mod' ? 'Ctrl' : k)).join('+');
  const glyph: Record<string, string> = { Mod: '⌘', Cmd: '⌘', Shift: '⇧', Alt: '⌥', Ctrl: '⌃' };
  return parts.map((k) => glyph[k] ?? k).join('');
}

export type ShortcutId =
  | 'quickConnect'
  | 'commandPalette'
  | 'find'
  | 'findNext'
  | 'findPrev'
  | 'closeTab'
  | 'nextTab'
  | 'prevTab'
  | 'jumpTab'
  | 'settings'
  | 'sidebar'
  | 'editor'
  | 'api'
  | 'ai'
  | 'zoomIn'
  | 'zoomOut'
  | 'zoomReset'
  | 'copy'
  | 'paste'
  | 'selectAll'
  | 'help';

type ChordSpec = string | { mac: string; pc: string; linux?: string };

// The chord each hint advertises — the one that works everywhere, including
// with focus inside a terminal (plain Ctrl+T/F/K/W still work elsewhere on
// Windows, but belong to the shell once you are typing in a session).
const SHORTCUTS: Record<ShortcutId, ChordSpec> = {
  quickConnect: { mac: 'Mod+T', pc: 'Ctrl+Shift+T' },
  commandPalette: { mac: 'Mod+K', pc: 'Ctrl+Shift+P' },
  find: { mac: 'Mod+F', pc: 'Ctrl+Shift+F' },
  findNext: { mac: 'Mod+G', pc: 'F3' },
  findPrev: { mac: 'Mod+Shift+G', pc: 'Shift+F3' },
  closeTab: { mac: 'Mod+W', pc: 'Ctrl+Shift+W' },
  nextTab: 'Ctrl+Tab',
  prevTab: 'Ctrl+Shift+Tab',
  jumpTab: { mac: 'Mod+1…9', pc: 'Alt+1…9' },
  settings: 'Mod+,',
  sidebar: 'Mod+B',
  editor: 'Mod+Shift+E',
  api: 'Mod+Shift+A',
  ai: 'Mod+Shift+I',
  zoomIn: 'Mod+=',
  zoomOut: 'Mod+-',
  zoomReset: 'Mod+0',
  // Ctrl+C also copies on Windows/Linux while text is selected, but
  // Ctrl+Shift+C is the chord that never risks a ^C reaching the device.
  copy: { mac: 'Mod+C', pc: 'Ctrl+Shift+C' },
  // Plain Ctrl+V is literal-next (^V) in Linux shells, so only Windows gets it.
  paste: { mac: 'Mod+V', pc: 'Ctrl+V', linux: 'Ctrl+Shift+V' },
  // Ctrl+A is the shell's beginning-of-line off macOS — no keyboard select-all.
  selectAll: { mac: 'Mod+A', pc: '' },
  help: 'F1',
};

/** OS-correct label for a named shortcut ('' when the OS has no chord for it). */
export function shortcutLabel(id: ShortcutId, p: Platform = platform): string {
  const spec = SHORTCUTS[id];
  const chord =
    typeof spec === 'string' ? spec : p === 'mac' ? spec.mac : p === 'linux' ? spec.linux ?? spec.pc : spec.pc;
  return chord ? formatChord(chord, p) : '';
}

/** "Search (⌘F)" / "Search (Ctrl+Shift+F)" — for button tooltips. */
export function withShortcut(label: string, id: ShortcutId, p: Platform = platform): string {
  const k = shortcutLabel(id, p);
  return k ? `${label} (${k})` : label;
}

/** The subset of KeyboardEvent the matchers read (keeps them unit-testable). */
export type KeyLike = Pick<KeyboardEvent, 'key' | 'code' | 'ctrlKey' | 'metaKey' | 'altKey' | 'shiftKey'>;

export type TabSwitch = { kind: 'next' } | { kind: 'prev' } | { kind: 'jump'; index: number };

/**
 * Tab-switching chords: Ctrl+Tab / Ctrl+Shift+Tab and Ctrl+PageDown/PageUp
 * everywhere; ⌘⇧] / ⌘⇧[ on macOS; jump to tab N with ⌘1–9 on macOS and
 * Alt+1–9 on Windows/Linux (Ctrl+digit is a real key to some CLIs, so it
 * stays with the device). Digits are matched by physical key (e.code) so
 * layouts that need Shift for digits (AZERTY) work, and the numeric keypad
 * is left alone so Windows Alt+keypad character codes still type.
 */
export function tabSwitchIntent(e: KeyLike, p: Platform = platform): TabSwitch | null {
  if (e.ctrlKey && !e.metaKey && !e.altKey) {
    if (e.key === 'Tab') return { kind: e.shiftKey ? 'prev' : 'next' };
    if (!e.shiftKey && e.key === 'PageDown') return { kind: 'next' };
    if (!e.shiftKey && e.key === 'PageUp') return { kind: 'prev' };
  }
  if (p === 'mac' && e.metaKey && e.shiftKey && !e.ctrlKey && !e.altKey) {
    if (e.code === 'BracketRight' || e.key === '}' || e.key === ']') return { kind: 'next' };
    if (e.code === 'BracketLeft' || e.key === '{' || e.key === '[') return { kind: 'prev' };
  }
  const digit = /^Digit([1-9])$/.exec(e.code ?? '');
  if (digit) {
    const jump =
      p === 'mac'
        ? e.metaKey && !e.ctrlKey && !e.altKey && !e.shiftKey
        : e.altKey && !e.ctrlKey && !e.metaKey && !e.shiftKey;
    if (jump) return { kind: 'jump', index: Number(digit[1]) - 1 };
  }
  return null;
}

/** Windows/Linux Ctrl+Shift+<letter> chord (never a shell key), or null. */
function pcCtrlShiftLetter(e: KeyLike, p: Platform): string | null {
  if (p === 'mac' || !e.ctrlKey || !e.shiftKey || e.altKey || e.metaKey) return null;
  return e.key.length === 1 ? e.key.toLowerCase() : null;
}

/** Find (⌘F on macOS, Ctrl+Shift+F on Windows/Linux — plain Ctrl+F is the shell's). */
export function isFindChord(e: KeyLike, p: Platform = platform): boolean {
  if (p === 'mac') return e.metaKey && !e.ctrlKey && !e.altKey && !e.shiftKey && e.key.toLowerCase() === 'f';
  return pcCtrlShiftLetter(e, p) === 'f';
}

/** New connection on Windows/Linux (Ctrl+Shift+T). macOS keeps ⌘T in App. */
export function isPcNewConnectionChord(e: KeyLike, p: Platform = platform): boolean {
  return pcCtrlShiftLetter(e, p) === 't';
}

/** Command palette on Windows/Linux (Ctrl+Shift+P). macOS keeps ⌘K in App. */
export function isPcPaletteChord(e: KeyLike, p: Platform = platform): boolean {
  return pcCtrlShiftLetter(e, p) === 'p';
}

/** Find next / previous while the Find bar is open: F3 / Shift+F3, plus ⌘G / ⌘⇧G on macOS. */
export function findStep(e: KeyLike, p: Platform = platform): 'next' | 'prev' | null {
  if (e.key === 'F3' && !e.ctrlKey && !e.metaKey && !e.altKey) return e.shiftKey ? 'prev' : 'next';
  if (p === 'mac' && e.metaKey && !e.ctrlKey && !e.altKey && e.key.toLowerCase() === 'g') {
    return e.shiftKey ? 'prev' : 'next';
  }
  return null;
}

// Windows/Linux Ctrl+Shift app chords: find, new connection, palette, close
// tab, and the Editor / API / AI panel toggles. xterm would otherwise ALSO
// send the matching control char (Ctrl+Shift+W = ^W, delete-word) to the device.
const PC_APP_LETTERS = new Set(['f', 't', 'p', 'w', 'e', 'a', 'i']);

/**
 * Keys the terminal must hand to the app instead of the device. xterm's
 * custom key handler returns false for these, so the keydown bubbles to the
 * window-level shortcut handler with nothing sent to the PTY. F3 is only
 * claimed while Find is open — otherwise it is a normal function key
 * (mc, some device menus).
 */
export function isAppChord(e: KeyLike, opts: { searchOpen: boolean }, p: Platform = platform): boolean {
  if (tabSwitchIntent(e, p)) return true;
  const letter = pcCtrlShiftLetter(e, p);
  if (letter && PC_APP_LETTERS.has(letter)) return true;
  if (opts.searchOpen && findStep(e, p)) return true;
  return false;
}

/**
 * Resolve a tab switch to the session id to activate, or null for no change.
 * Popped-out sessions live in their own window — activating one here blanks
 * the terminal area — so cycling skips them and jumping to one does nothing.
 */
export function resolveTabSwitch(
  intent: TabSwitch,
  sessionIds: string[],
  popped: string[],
  activeId: string | null,
): string | null {
  if (intent.kind === 'jump') {
    const id = sessionIds[intent.index];
    return id && !popped.includes(id) && id !== activeId ? id : null;
  }
  const n = sessionIds.length;
  if (n < 2) return null;
  const cur = activeId ? sessionIds.indexOf(activeId) : -1;
  const dir = intent.kind === 'next' ? 1 : -1;
  for (let step = 1; step <= n; step++) {
    // With no active tab, start from the edge so "next" lands on the first.
    const base = cur < 0 ? (dir > 0 ? -1 : n) : cur;
    const id = sessionIds[(((base + dir * step) % n) + n) % n];
    if (popped.includes(id)) continue;
    return id !== activeId ? id : null;
  }
  return null;
}
