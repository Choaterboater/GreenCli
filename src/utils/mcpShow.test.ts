import { describe, expect, it } from 'vitest';
import { argsSize, showArgs, showName, showText } from './mcpShow';

const ch = (code: number) => String.fromCodePoint(code);

describe('showText', () => {
  it('makes hidden and reordering characters visible', () => {
    expect(showText(`a${ch(0x202e)}b`)).toBe('a\\u{202E}b');
    expect(showText(`a${ch(0x200b)}b`)).toBe('a\\u{200B}b');
    expect(showText(`a${ch(0x2028)}b`)).toBe('a\\u{2028}b');
    expect(showText(`a${ch(0x85)}b`)).toBe('a\\u{0085}b');
    expect(showText(`a${ch(0xfeff)}${ch(0x2066)}${ch(0x61c)}b`)).toBe('a\\u{FEFF}\\u{2066}\\u{061C}b');
    expect(showText('a\u0000b\u007fc\u001bd')).toBe('a\\u{0000}b\\u{007F}c\\u{001B}d');
  });

  it('leaves plain text, tabs and line breaks alone', () => {
    const plain = 'show interfaces | match ge-0/0/1\n\tdone ~ é 中';
    expect(showText(plain)).toBe(plain);
  });
});

describe('showName', () => {
  it('caps long names at 64 characters', () => {
    const shown = showName('x'.repeat(100));
    expect([...shown]).toHaveLength(64);
    expect(shown.endsWith('…')).toBe(true);
    expect(showName('get_device')).toBe('get_device');
  });
});

describe('showArgs and argsSize', () => {
  it('pretty-prints and cleans the arguments', () => {
    expect(showArgs({ name: `x${ch(0x202e)}` })).toBe('{\n  "name": "x\\u{202E}"\n}');
  });

  it('sums up the size', () => {
    expect(argsSize({ a: 1 })).toBe('3 lines, 12 bytes');
    expect(argsSize({ text: 'x'.repeat(2000) })).toBe('3 lines, 2.0 KB');
    expect(argsSize({})).toBe('1 line, 2 bytes');
  });
});
