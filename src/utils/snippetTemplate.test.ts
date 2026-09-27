import { describe, it, expect } from 'vitest';
import { fillPlaceholders, snippetPlaceholders } from './snippetTemplate';

describe('snippetPlaceholders', () => {
  it('lists each distinct name once, in order', () => {
    expect(snippetPlaceholders('show interface {{port}}\nshow lldp neighbor-info {{ port }}\nping {{host}}')).toEqual([
      'port',
      'host',
    ]);
  });

  it('returns nothing for a plain command or a lone brace', () => {
    expect(snippetPlaceholders('show version')).toEqual([]);
    expect(snippetPlaceholders('show {port}')).toEqual([]);
  });
});

describe('fillPlaceholders', () => {
  it('fills every occurrence, including multi-line snippets', () => {
    expect(fillPlaceholders('interface {{port}}\n  description {{desc}}\nshow int {{port}}', { port: '1/1/1', desc: 'uplink' })).toBe(
      'interface 1/1/1\n  description uplink\nshow int 1/1/1'
    );
  });

  it('leaves names without a value untouched and ignores $ patterns in values', () => {
    expect(fillPlaceholders('ping {{host}} {{count}}', { host: '10.0.0.$1' })).toBe('ping 10.0.0.$1 {{count}}');
  });
});
