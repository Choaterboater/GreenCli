import { beforeEach, describe, expect, it, vi } from 'vitest';
import * as engine from './engine';
import { MAX_JSON_DEPTH, MAX_SCRUB_CHARS, TOOL_RESULT_CAP, WITHHELD_TEXT, capHead, capTail, prepareToolResult, rawErr, rawJson, rawOk, rawTerminal } from './forAi';
import { secretFilterSupported } from './support';

vi.mock('./support', () => ({ secretFilterSupported: vi.fn(() => true) }));
vi.mock('./engine', async (importOriginal) => {
  const real = await importOriginal<typeof import('./engine')>();
  return { ...real, scrubForAi: vi.fn(real.scrubForAi) };
});

const HIDDEN = '<secret hidden>';

beforeEach(() => {
  vi.mocked(secretFilterSupported).mockClear();
  vi.mocked(engine.scrubForAi).mockClear();
});

describe('terminal output', () => {
  it('hides secrets and adds a note for the tool row', async () => {
    const output = 'sw1# show running-config\nhostname sw1\nradius-server host 10.1.1.10 key plaintext RadKeyCX vrf mgmt\nsw1# ';
    const result = await prepareToolResult(rawTerminal(output, 'show running-config', false));
    expect(result.text).not.toContain('RadKeyCX');
    expect(result.text).toContain(`key plaintext ${HIDDEN} vrf mgmt`);
    expect(result.isError).toBe(false);
    expect(result.note).toBe('1 secret hidden before the AI saw this (passwords).');
  });

  it('hides a key body whose BEGIN line was on an earlier page', async () => {
    // The AI pressed Space at --More--: the page has no command echo and starts mid-key.
    const page = 'b3BlbnNzaC1rZXktdjEAAAA\nAAAABG5vbmUAAAAEbm9uZQ\n-----END OPENSSH PRIVATE KEY-----\nsw1# ';
    const result = await prepareToolResult(rawTerminal(page, ' ', false));
    expect(result.text).not.toContain('b3BlbnNzaC1rZXktdjEAAAA');
    expect(result.text).not.toContain('AAAABG5vbmUAAAAEbm9uZQ');
  });

  it('treats a trimmed capture without the command echo as starting mid-block', async () => {
    // The backend kept only the tail of the buffer: the echo and the aaa line are gone.
    const output = '   key RadKeyAOS8\n!\nhostname ctrl1';
    const result = await prepareToolResult(rawTerminal(output, 'show run', true));
    expect(result.text).toBe(`[capture may be truncated]\n   key ${HIDDEN}\n!\nhostname ctrl1`);
  });

  it('scrubs before capping, so a key cut by the cap still never shows', async () => {
    const body = Array.from({ length: 1000 }, (_, i) => `MIIEowIBAAKCAQEA${String(i).padStart(4, '0')}Zm9vYmFyYmF6cXV4cXV1eA`).join('\n');
    const output = `sw1# show crypto pki\n-----BEGIN RSA PRIVATE KEY-----\n${body}\n-----END RSA PRIVATE KEY-----\nsw1# `;
    expect(output.length).toBeGreaterThan(TOOL_RESULT_CAP);
    const result = await prepareToolResult(rawTerminal(output, 'show crypto pki', false));
    expect(result.text).not.toMatch(/MIIEowIBAAKCAQEA\d{4}/);
    expect(result.text.startsWith('…(truncated)…\n')).toBe(true);
  });

  it('adds the default-community hint without showing the value', async () => {
    const result = await prepareToolResult(rawTerminal('sw1# show run\nsnmp-server community public\n', 'show run', false));
    expect(result.text).toContain(`snmp-server community ${HIDDEN}`);
    expect(result.text).not.toMatch(/community public/);
    expect(result.text.endsWith(engine.DEFAULT_COMMUNITY_HINT)).toBe(true);
  });

  it('reports an empty capture as before', async () => {
    const result = await prepareToolResult(rawTerminal('', 'show clock', true));
    expect(result.text).toBe('[capture may be truncated]\nCommand `show clock` sent — no output captured (may be interactive, paged, or still running).');
    expect(result.note).toBeUndefined();
  });
});

describe('REST and MCP results', () => {
  it('hides a password in a REST object and shows the rest as JSON', async () => {
    const result = await prepareToolResult(rawJson({ name: 'admin', password: 'AQBapWq3Zm9v', group: 'administrators' }));
    expect(JSON.parse(result.text)).toEqual({ name: 'admin', password: HIDDEN, group: 'administrators' });
    expect(result.note).toBe('1 secret hidden before the AI saw this (passwords).');
  });

  it('keeps hpe-mcp paging fields while hiding the PSK in MCP text', async () => {
    const text = JSON.stringify({
      items: [{ name: 'corp', psk: 'Corp-PSK-2024!' }],
      _pagination: { list_key: 'items', next_cursor: 'c2', key: 'k' },
    });
    const parsed = JSON.parse((await prepareToolResult(rawJson(text))).text);
    expect(parsed.items[0]).toEqual({ name: 'corp', psk: HIDDEN });
    expect(parsed._pagination).toEqual({ list_key: 'items', next_cursor: 'c2', key: 'k' });
  });

  it('withholds a result nested too deep for the walk to check', async () => {
    let deep: unknown = { password: 'DeepSecret1!' };
    for (let i = 0; i < MAX_JSON_DEPTH + 5; i++) deep = { next: deep };
    for (const value of [deep, JSON.stringify(deep)]) {
      const result = await prepareToolResult(rawJson(value));
      expect(result.text).toBe(WITHHELD_TEXT);
      expect(result.isError).toBe(true);
    }
  });

  it('caps long JSON from the head and says how much was cut', async () => {
    const result = await prepareToolResult(rawJson({ rows: Array.from({ length: 2000 }, (_, i) => ({ i, name: `port-${i}` })) }));
    expect(result.text.length).toBeLessThan(TOOL_RESULT_CAP + 100);
    expect(result.text).toMatch(/\n…\(truncated \d+ more chars\)$/);
    expect(result.text.startsWith('{')).toBe(true);
  });
});

describe('errors and plain text', () => {
  it('scrubs error text too', async () => {
    const result = await prepareToolResult(rawErr('AOS-S REST error: 400 {"password": "Hunter22!x"}'));
    expect(result.text).not.toContain('Hunter22!x');
    expect(result.isError).toBe(true);
  });

  it('passes plain results through', async () => {
    expect(await prepareToolResult(rawOk('3 of 3 intents passing'))).toEqual({ text: '3 of 3 intents passing', isError: false });
  });
});

describe('fail closed', () => {
  it('withholds output when this system cannot run the filter', async () => {
    vi.mocked(secretFilterSupported).mockReturnValueOnce(false);
    const result = await prepareToolResult(rawTerminal('sw1# show run\nhostname sw1', 'show run', false));
    expect(result).toEqual({ text: WITHHELD_TEXT, isError: true, note: 'Output withheld: the secret filter cannot run on this system.' });
  });

  it('withholds output when the filter throws', async () => {
    vi.mocked(engine.scrubForAi).mockImplementationOnce(() => {
      throw new SyntaxError('Invalid regular expression: invalid group specifier name');
    });
    const result = await prepareToolResult(rawOk('radius-server host 10.1.1.10 key RadKey'));
    expect(result.text).toBe(WITHHELD_TEXT);
    expect(result.isError).toBe(true);
  });
});

describe('size limits', () => {
  it('scrubs a 150 KB config quickly enough for the UI thread', async () => {
    const block = (i: number) =>
      [
        `interface 1/1/${i % 48}`,
        `    description uplink-${i} to closet ${i % 7}`,
        '    no shutdown',
        `    vlan trunk allowed 10,20,${100 + (i % 50)}`,
        `    ip ospf authentication-key ciphertext AQBospfKey${i}==`,
        '    exit',
      ].join('\n');
    const config = ['hostname core-cx', ...Array.from({ length: 1200 }, (_, i) => block(i))].join('\n');
    expect(config.length).toBeGreaterThan(150_000);
    const started = performance.now();
    const result = await prepareToolResult(rawTerminal(`core-cx# show running-config\n${config}`, 'show running-config', false));
    const took = performance.now() - started;
    expect(result.text).not.toMatch(/AQBospfKey\d+==/);
    expect(took).toBeLessThan(300);
  });

  it('cuts runaway text before scrubbing, and hides a line too long to check', async () => {
    const huge = `${'tokentoken'.repeat(MAX_SCRUB_CHARS / 10)}\nradius-server host 10.1.1.10 key plaintext TailKey`;
    const started = performance.now();
    const result = await prepareToolResult(rawOk(huge));
    expect(performance.now() - started).toBeLessThan(1000);
    expect(result.text).toBe('<line hidden: secret>');
  });

  it('parses oversized MCP JSON before cutting it, so its keys are still checked', async () => {
    const rows = Array.from({ length: 20_000 }, (_, i) => ({ id: i, name: `ap-${i}`, note: 'x'.repeat(40) }));
    const text = JSON.stringify({ wlan: { ssid: 'corp', psk: 'Corp-PSK-2024!' }, rows });
    expect(text.length).toBeGreaterThan(MAX_SCRUB_CHARS);
    const result = await prepareToolResult(rawJson(text));
    expect(result.text).not.toContain('Corp-PSK-2024!');
    expect(result.text).toContain(`"psk": "${HIDDEN}"`);
  });
});

describe('caps', () => {
  it('keep the head or the tail and mark the cut', () => {
    expect(capHead('abcdef', 3)).toBe('abc\n…(truncated 3 more chars)');
    expect(capTail('abcdef', 3)).toBe('…(truncated)…\ndef');
    expect(capHead('abc', 3)).toBe('abc');
  });
});
