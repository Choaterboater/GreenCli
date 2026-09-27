import { describe, it, expect } from 'vitest';
import {
  detectPlatform,
  findStep,
  formatChord,
  isAppChord,
  isFindChord,
  isPcNewConnectionChord,
  isPcPaletteChord,
  resolveTabSwitch,
  shortcutLabel,
  tabSwitchIntent,
  withShortcut,
  type KeyLike,
} from './shortcuts';

const key = (k: Partial<KeyLike>): KeyLike => ({
  key: '',
  code: '',
  ctrlKey: false,
  metaKey: false,
  altKey: false,
  shiftKey: false,
  ...k,
});

describe('detectPlatform', () => {
  it('maps navigator.platform strings', () => {
    expect(detectPlatform('MacIntel')).toBe('mac');
    expect(detectPlatform('Win32')).toBe('windows');
    expect(detectPlatform('Linux x86_64')).toBe('linux');
  });
});

describe('formatChord / shortcutLabel', () => {
  it('uses glyphs on macOS and spelled-out modifiers elsewhere', () => {
    expect(formatChord('Mod+Shift+E', 'mac')).toBe('⌘⇧E');
    expect(formatChord('Mod+Shift+E', 'windows')).toBe('Ctrl+Shift+E');
    expect(formatChord('Ctrl+Tab', 'mac')).toBe('⌃Tab');
  });

  it('advertises the chord that works from inside a terminal', () => {
    expect(shortcutLabel('find', 'mac')).toBe('⌘F');
    expect(shortcutLabel('find', 'windows')).toBe('Ctrl+Shift+F');
    expect(shortcutLabel('quickConnect', 'windows')).toBe('Ctrl+Shift+T');
    expect(shortcutLabel('commandPalette', 'mac')).toBe('⌘K');
    expect(shortcutLabel('commandPalette', 'linux')).toBe('Ctrl+Shift+P');
    expect(shortcutLabel('closeTab', 'windows')).toBe('Ctrl+Shift+W');
    expect(shortcutLabel('jumpTab', 'windows')).toBe('Alt+1…9');
    expect(shortcutLabel('jumpTab', 'mac')).toBe('⌘1…9');
  });

  it('knows paste differs between Windows and Linux', () => {
    expect(shortcutLabel('paste', 'mac')).toBe('⌘V');
    expect(shortcutLabel('paste', 'windows')).toBe('Ctrl+V');
    expect(shortcutLabel('paste', 'linux')).toBe('Ctrl+Shift+V');
  });

  it('returns empty for a chord the OS does not have', () => {
    expect(shortcutLabel('selectAll', 'windows')).toBe('');
    expect(withShortcut('Select all', 'selectAll', 'windows')).toBe('Select all');
    expect(withShortcut('Settings', 'settings', 'mac')).toBe('Settings (⌘,)');
  });
});

describe('tabSwitchIntent', () => {
  it('cycles with Ctrl+Tab / Ctrl+Shift+Tab and Ctrl+PgDn / PgUp on every OS', () => {
    for (const p of ['mac', 'windows', 'linux'] as const) {
      expect(tabSwitchIntent(key({ key: 'Tab', ctrlKey: true }), p)).toEqual({ kind: 'next' });
      expect(tabSwitchIntent(key({ key: 'Tab', ctrlKey: true, shiftKey: true }), p)).toEqual({ kind: 'prev' });
      expect(tabSwitchIntent(key({ key: 'PageDown', ctrlKey: true }), p)).toEqual({ kind: 'next' });
      expect(tabSwitchIntent(key({ key: 'PageUp', ctrlKey: true }), p)).toEqual({ kind: 'prev' });
    }
  });

  it('uses Cmd+Shift+[ / ] on macOS only', () => {
    const next = key({ key: '}', code: 'BracketRight', metaKey: true, shiftKey: true });
    const prev = key({ key: '{', code: 'BracketLeft', metaKey: true, shiftKey: true });
    expect(tabSwitchIntent(next, 'mac')).toEqual({ kind: 'next' });
    expect(tabSwitchIntent(prev, 'mac')).toEqual({ kind: 'prev' });
    expect(tabSwitchIntent(next, 'windows')).toBeNull();
  });

  it('jumps with Cmd+digit on macOS and Alt+digit on Windows/Linux', () => {
    expect(tabSwitchIntent(key({ key: '3', code: 'Digit3', metaKey: true }), 'mac')).toEqual({ kind: 'jump', index: 2 });
    expect(tabSwitchIntent(key({ key: '3', code: 'Digit3', altKey: true }), 'windows')).toEqual({ kind: 'jump', index: 2 });
    // AZERTY: the digit row needs Shift for digits but e.code is still DigitN.
    expect(tabSwitchIntent(key({ key: '"', code: 'Digit3', altKey: true }), 'linux')).toEqual({ kind: 'jump', index: 2 });
  });

  it('leaves Ctrl+digit, Option+digit, AltGr and the keypad to the device', () => {
    expect(tabSwitchIntent(key({ key: '3', code: 'Digit3', ctrlKey: true }), 'windows')).toBeNull();
    expect(tabSwitchIntent(key({ key: '3', code: 'Digit3', ctrlKey: true }), 'mac')).toBeNull();
    expect(tabSwitchIntent(key({ key: '£', code: 'Digit3', altKey: true }), 'mac')).toBeNull();
    // Windows reports AltGr as Ctrl+Alt.
    expect(tabSwitchIntent(key({ key: '{', code: 'Digit7', ctrlKey: true, altKey: true }), 'windows')).toBeNull();
    // Alt+keypad digits type Windows Alt codes.
    expect(tabSwitchIntent(key({ key: '1', code: 'Numpad1', altKey: true }), 'windows')).toBeNull();
    expect(tabSwitchIntent(key({ key: '0', code: 'Digit0', altKey: true }), 'windows')).toBeNull();
  });
});

describe('find / connection / palette chords', () => {
  it('finds with Cmd+F on macOS and Ctrl+Shift+F elsewhere — never plain Ctrl+F', () => {
    expect(isFindChord(key({ key: 'f', metaKey: true }), 'mac')).toBe(true);
    expect(isFindChord(key({ key: 'F', ctrlKey: true, shiftKey: true }), 'windows')).toBe(true);
    expect(isFindChord(key({ key: 'f', ctrlKey: true }), 'windows')).toBe(false);
    expect(isFindChord(key({ key: 'f', ctrlKey: true }), 'mac')).toBe(false);
  });

  it('Ctrl+Shift+T / P are Windows/Linux only', () => {
    expect(isPcNewConnectionChord(key({ key: 'T', ctrlKey: true, shiftKey: true }), 'windows')).toBe(true);
    expect(isPcNewConnectionChord(key({ key: 'T', ctrlKey: true, shiftKey: true }), 'mac')).toBe(false);
    expect(isPcPaletteChord(key({ key: 'P', ctrlKey: true, shiftKey: true }), 'linux')).toBe(true);
    expect(isPcPaletteChord(key({ key: 'p', ctrlKey: true }), 'linux')).toBe(false);
  });

  it('steps through matches with F3 / Shift+F3 and Cmd+G / Cmd+Shift+G on macOS', () => {
    expect(findStep(key({ key: 'F3' }), 'windows')).toBe('next');
    expect(findStep(key({ key: 'F3', shiftKey: true }), 'windows')).toBe('prev');
    expect(findStep(key({ key: 'g', metaKey: true }), 'mac')).toBe('next');
    expect(findStep(key({ key: 'G', metaKey: true, shiftKey: true }), 'mac')).toBe('prev');
    expect(findStep(key({ key: 'g', ctrlKey: true }), 'windows')).toBeNull();
  });
});

describe('isAppChord (keys the terminal hands to the app)', () => {
  const closed = { searchOpen: false };
  it('claims tab switching and the Ctrl+Shift app chords', () => {
    expect(isAppChord(key({ key: 'Tab', ctrlKey: true }), closed, 'windows')).toBe(true);
    expect(isAppChord(key({ key: '2', code: 'Digit2', altKey: true }), closed, 'windows')).toBe(true);
    for (const letter of ['F', 'T', 'P', 'W', 'E', 'A', 'I']) {
      expect(isAppChord(key({ key: letter, ctrlKey: true, shiftKey: true }), closed, 'windows')).toBe(true);
    }
  });

  it('leaves shell keys, copy/paste chords and plain Ctrl letters to the terminal', () => {
    expect(isAppChord(key({ key: 'f', ctrlKey: true }), closed, 'windows')).toBe(false);
    expect(isAppChord(key({ key: 'w', ctrlKey: true }), closed, 'linux')).toBe(false);
    expect(isAppChord(key({ key: 'C', ctrlKey: true, shiftKey: true }), closed, 'windows')).toBe(false);
    expect(isAppChord(key({ key: 'Tab' }), closed, 'windows')).toBe(false);
    // macOS keeps Ctrl+Shift letters for the device (the app uses ⌘ there).
    expect(isAppChord(key({ key: 'F', ctrlKey: true, shiftKey: true }), closed, 'mac')).toBe(false);
  });

  it('claims F3 only while Find is open', () => {
    expect(isAppChord(key({ key: 'F3' }), closed, 'windows')).toBe(false);
    expect(isAppChord(key({ key: 'F3' }), { searchOpen: true }, 'windows')).toBe(true);
  });
});

describe('resolveTabSwitch', () => {
  const ids = ['a', 'b', 'c', 'd'];

  it('cycles forwards and backwards with wrap-around', () => {
    expect(resolveTabSwitch({ kind: 'next' }, ids, [], 'd')).toBe('a');
    expect(resolveTabSwitch({ kind: 'prev' }, ids, [], 'a')).toBe('d');
    expect(resolveTabSwitch({ kind: 'next' }, ids, [], 'b')).toBe('c');
  });

  it('skips popped-out sessions', () => {
    expect(resolveTabSwitch({ kind: 'next' }, ids, ['b', 'c'], 'a')).toBe('d');
    expect(resolveTabSwitch({ kind: 'prev' }, ids, ['d'], 'a')).toBe('c');
    expect(resolveTabSwitch({ kind: 'next' }, ids, ['b', 'c', 'd'], 'a')).toBeNull();
  });

  it('jumps to tab N unless it is popped out, missing or already active', () => {
    expect(resolveTabSwitch({ kind: 'jump', index: 2 }, ids, [], 'a')).toBe('c');
    expect(resolveTabSwitch({ kind: 'jump', index: 2 }, ids, ['c'], 'a')).toBeNull();
    expect(resolveTabSwitch({ kind: 'jump', index: 8 }, ids, [], 'a')).toBeNull();
    expect(resolveTabSwitch({ kind: 'jump', index: 0 }, ids, [], 'a')).toBeNull();
  });

  it('does nothing with a single tab', () => {
    expect(resolveTabSwitch({ kind: 'next' }, ['a'], [], 'a')).toBeNull();
  });
});
