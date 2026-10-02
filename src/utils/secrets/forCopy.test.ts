import { beforeEach, describe, expect, it, vi } from 'vitest';
import * as engine from './engine';
import { MAX_SCRUB_CHARS } from './forAi';
import { hideSecretsForCopy } from './forCopy';
import { secretFilterSupported } from './support';

vi.mock('./support', () => ({ secretFilterSupported: vi.fn(() => true) }));
vi.mock('./engine', async (importOriginal) => {
  const real = await importOriginal<typeof import('./engine')>();
  return { ...real, scrubForAi: vi.fn(real.scrubForAi) };
});

beforeEach(() => {
  vi.mocked(secretFilterSupported).mockReturnValue(true);
  vi.mocked(engine.scrubForAi).mockClear();
});

const CONFIG = [
  'hostname core-sw1',
  'user admin group administrators password plaintext Sup3rSecret!',
  'radius-server host 10.1.1.10 key plaintext RadKeyCX vrf mgmt',
  'snmp-server community n0tPublic',
  'interface 1/1/1',
  '    description uplink',
].join('\n');

describe('hideSecretsForCopy', () => {
  it('hides every secret, keeps the rest, and says what it hid', async () => {
    const result = await hideSecretsForCopy(CONFIG);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    for (const secret of ['Sup3rSecret!', 'RadKeyCX', 'n0tPublic']) expect(result.text).not.toContain(secret);
    expect(result.text).toContain('hostname core-sw1');
    expect(result.text).toContain('    description uplink');
    expect(result.hidden).toBe(3);
    expect(result.message).toMatch(/^Copied with 3 secrets hidden \(.+\)$/);
  });

  it('says so when there was nothing to hide', async () => {
    const result = await hideSecretsForCopy('hostname core-sw1\nvlan 10\n    name users');
    expect(result).toMatchObject({ ok: true, hidden: 0, message: 'Copied: no secrets found' });
  });

  it('hides a key line from a piece cut out of a RADIUS block', async () => {
    // A selection from a session can start inside the block.
    const result = await hideSecretsForCopy('   key RadKeyAOS8\n!\nhostname ctrl1');
    expect(result.ok && result.text).not.toContain('RadKeyAOS8');
  });

  it('copies nothing when the filter cannot run', async () => {
    vi.mocked(secretFilterSupported).mockReturnValue(false);
    const result = await hideSecretsForCopy(CONFIG);
    expect(result.ok).toBe(false);
    expect(JSON.stringify(result)).not.toContain('Sup3rSecret!');
  });

  it('copies nothing when the filter throws', async () => {
    vi.mocked(engine.scrubForAi).mockImplementationOnce(() => {
      throw new Error('boom');
    });
    const result = await hideSecretsForCopy(CONFIG);
    expect(result).toEqual({ ok: false, message: 'Not copied: GreenCLI could not check this text for secrets on this system.' });
  });

  it('refuses a tab too big to check rather than copying part of it', async () => {
    const result = await hideSecretsForCopy('x'.repeat(MAX_SCRUB_CHARS + 1));
    expect(result.ok).toBe(false);
    expect(engine.scrubForAi).not.toHaveBeenCalled();
  });
});
