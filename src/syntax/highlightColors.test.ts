import { describe, expect, it } from 'vitest';
import { ANSI_COLORS, ArubaHighlighter } from './highlighter';
import { DARK_TERMINAL_THEME, LIGHT_TERMINAL_THEME, type TerminalTheme } from '../types';
import { contrastRatio } from '../utils/contrast';

/** The theme color xterm draws for a basic SGR foreground code. */
const SGR_TO_THEME: Record<string, keyof TerminalTheme> = {
  '\x1b[31m': 'red',
  '\x1b[33m': 'yellow',
  '\x1b[34m': 'blue',
  '\x1b[35m': 'magenta',
  '\x1b[36m': 'cyan',
  '\x1b[90m': 'brightBlack',
};

describe('SSH highlight colors', () => {
  it('use only the terminal theme\'s own colors, so they follow light/dark and every scheme', () => {
    for (const [token, code] of Object.entries(ANSI_COLORS)) {
      if (token === 'token-default') continue;
      expect([token, code in SGR_TO_THEME]).toEqual([token, true]);
    }
  });

  it('are easy to read on both GreenCLI backgrounds', () => {
    for (const theme of [DARK_TERMINAL_THEME, LIGHT_TERMINAL_THEME]) {
      for (const [token, code] of Object.entries(ANSI_COLORS)) {
        if (token === 'token-default') continue;
        const color = theme[SGR_TO_THEME[code]];
        // Comments are meant to be dimmer; everything else meets WCAG AA for text.
        const minimum = token === 'token-cmd-comment' ? 4 : 4.5;
        const ratio = contrastRatio(color, theme.background);
        expect([theme.background, token, ratio >= minimum]).toEqual([theme.background, token, true]);
      }
    }
  });
});

describe('comment lines', () => {
  const cx = ArubaHighlighter.forDeviceType('aruba-cx');
  const junos = ArubaHighlighter.forDeviceType('juniper-junos');
  const generic = ArubaHighlighter.forDeviceType('generic');

  it('dim a whole Aruba ! line and a Junos # or /* */ line', () => {
    expect(cx.applyToTerminal('! last change by netops')).toBe('\x1b[90m! last change by netops\x1b[39m');
    expect(cx.applyToTerminal('   !Version ArubaOS-CX GL.10.13')).toBe('\x1b[90m   !Version ArubaOS-CX GL.10.13\x1b[39m');
    expect(junos.applyToTerminal('## Last commit: 2026-10-01 by netops')).toBe('\x1b[90m## Last commit: 2026-10-01 by netops\x1b[39m');
    expect(junos.applyToTerminal('/* uplink to core */')).toBe('\x1b[90m/* uplink to core */\x1b[39m');
  });

  it('never treats a prompt, a mid-line ! or generic output as a comment', () => {
    expect(cx.processLine('core-sw1# show vlan')[0].className).toBe('token-cmd-prompt');
    expect(cx.processLine('interface 1/1/1 ! note').some((t) => t.className === 'token-cmd-comment')).toBe(false);
    // A Linux root shell prompt starts with "# ".
    expect(generic.processLine('# ls -la').some((t) => t.className === 'token-cmd-comment')).toBe(false);
  });
});
