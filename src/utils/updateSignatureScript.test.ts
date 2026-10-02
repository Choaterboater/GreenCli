// scripts/update-signature.mjs is what release.yml runs to check update files
// before a draft release is published. These tests run it the same way, on a
// file signed like a release build signs one (the same fixture as the Rust
// test release_signatures_verify_with_the_fetched_key in updater.rs).

import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

const SCRIPT = resolve(process.cwd(), 'scripts/update-signature.mjs');
const REPO = 'Choaterboater/GreenCli';

/** Public keys and a signature only: the private keys were deleted. */
const SIGNED_PUB =
  'dW50cnVzdGVkIGNvbW1lbnQ6IG1pbmlzaWduIHB1YmxpYyBrZXk6IDZEMDdBRjE0NDk5M0ZEQ0YKUldUUC9aTkpGSzhIYlVnRGd4UjJJOWRMeVRoUVMvZytOTC9FRWFVNSs5RExnYmFsWmdsY1pWcjkK';
const SIGNED_SIG =
  'dW50cnVzdGVkIGNvbW1lbnQ6IHNpZ25hdHVyZSBmcm9tIHRhdXJpIHNlY3JldCBrZXkKUlVUUC9aTkpGSzhIYlEyemFrNWo5SFB0RHpoOFkwWDVqcnVFOGpxeTBPc3MvRUhERjROQ3NoVzJoUFgrTjlEQzBtckJMZDJrQnZDVHM4enZxazVDTFA3elFMbytqOVA1dUE0PQp0cnVzdGVkIGNvbW1lbnQ6IHRpbWVzdGFtcDoxNzkwOTQ5MTU0CWZpbGU6Zml4dHVyZS50eHQJdmVyc2lvbjoyLjAuMQpXN1ZzeHBISzVxRWgwbExWYVEreGhmdHM5UUczUUNBK2lMTVJzcFk0bkFqdTEveWdzb3BhNDZBTTZWQ2dpbWNHbVVHeWhZZ3R0cG9ORmUyOXM3NlZEUT09Cg==';
const OTHER_PUB =
  'dW50cnVzdGVkIGNvbW1lbnQ6IG1pbmlzaWduIHB1YmxpYyBrZXk6IDg2Q0EzNTY5MkZFMzg0NzAKUldSd2hPTXZhVFhLaHE3bDdsNmdqQnpkS3FzUEF0c1pQM1JFdmZicTR1SkFZY1huZDNoMlBtakMK';
const SIGNED_DATA = 'GreenCLI update test\n';

const dirs: string[] = [];
function tempDir(): string {
  const d = mkdtempSync(join(tmpdir(), 'greencli-update-sig-'));
  dirs.push(d);
  return d;
}

afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function run(...args: string[]) {
  const r = spawnSync(process.execPath, [SCRIPT, ...args], { encoding: 'utf8' });
  return { code: r.status, out: r.stdout, err: r.stderr };
}

describe('update-signature.mjs verify-dir (each build job)', () => {
  function bundle(data = SIGNED_DATA) {
    const d = tempDir();
    writeFileSync(join(d, 'GreenCLI.app.tar.gz'), data);
    writeFileSync(join(d, 'GreenCLI.app.tar.gz.sig'), SIGNED_SIG);
    return d;
  }
  function key(text: string) {
    const f = join(tempDir(), 'updkey.pub');
    writeFileSync(f, text);
    return f;
  }

  it('passes when every signature matches its file and the build key', () => {
    const r = run('verify-dir', bundle(), key(SIGNED_PUB));
    expect(r.code).toBe(0);
    expect(r.out).toContain('ok  GreenCLI.app.tar.gz');
  });

  it('fails for another key, a changed file, junk or no signatures', () => {
    expect(run('verify-dir', bundle(), key(OTHER_PUB)).err).toContain('different key');
    expect(run('verify-dir', bundle('GreenCLI update test!\n'), key(SIGNED_PUB)).err).toContain(
      'does not match the file',
    );
    expect(run('verify-dir', bundle(), key('junk')).code).toBe(1);
    expect(run('verify-dir', tempDir(), key(SIGNED_PUB)).err).toContain('No update signatures');
  });
});

describe('update-signature.mjs check-release (the update-files job)', () => {
  const ASSETS = [
    { id: 11, name: 'GreenCLI.app.tar.gz' },
    { id: 12, name: 'latest.json' },
  ];

  /** A release folder as the update-files job downloads it. */
  function release({
    version = '2.0.1',
    url = `https://api.github.com/repos/${REPO}/releases/assets/11`,
    keys = { 'darwin-aarch64': SIGNED_PUB } as Record<string, string>,
    data = SIGNED_DATA,
  } = {}) {
    const d = tempDir();
    const manifest = {
      version,
      platforms: { 'darwin-aarch64': { url, signature: SIGNED_SIG } },
    };
    writeFileSync(join(d, 'latest.json'), JSON.stringify(manifest));
    writeFileSync(join(d, 'GreenCLI.app.tar.gz'), data);
    for (const [p, k] of Object.entries(keys)) writeFileSync(join(d, `update-key-${p}.pub`), k);
    const assets = join(tempDir(), 'assets.json');
    writeFileSync(assets, JSON.stringify(ASSETS));
    return { d, assets };
  }

  function check(r: { d: string; assets: string }, tag = 'v2.0.1', platforms = ['darwin-aarch64']) {
    return run('check-release', r.d, r.assets, REPO, tag, ...platforms);
  }

  it('passes a good release', () => {
    const r = check(release());
    expect(r.err).toBe('');
    expect(r.code).toBe(0);
    expect(r.out).toContain('ok  darwin-aarch64  GreenCLI.app.tar.gz');
  });

  it("checks each entry with its own platform's key from the release", () => {
    expect(check(release({ keys: { 'darwin-aarch64': OTHER_PUB } })).err).toContain('different key');
    expect(check(release({ keys: { 'darwin-x86_64': SIGNED_PUB } })).err).toContain(
      'the release has no update-key-darwin-aarch64.pub',
    );
    expect(check(release({ data: 'swapped\n' })).err).toContain('does not match the file');
  });

  it('needs the tag to be v<version>, a plain version and every platform', () => {
    expect(check(release(), 'v2.0.2').err).toContain('The app looks for the tag v2.0.1');
    expect(check(release({ version: '2.0.1+5' }), 'v2.0.1+5').err).toContain('not a plain version');
    expect(check(release(), 'v2.0.1', ['darwin-aarch64', 'windows-x86_64']).err).toContain(
      'latest.json has no windows-x86_64 entry',
    );
  });

  it('needs every file to be an asset of this release', () => {
    for (const url of [
      `https://api.github.com/repos/someone/GreenCli/releases/assets/11`,
      `https://api.github.com/repos/${REPO}/releases/assets/99`,
      `https://github.com/${REPO}/releases/download/v2.0.0/GreenCLI.app.tar.gz`,
      'https://example.com/GreenCLI.app.tar.gz',
    ]) {
      expect(check(release({ url })).err, url).toContain('is not a file of the v2.0.1 release');
    }
    const web = `https://github.com/${REPO}/releases/download/v2.0.1/GreenCLI.app.tar.gz`;
    expect(check(release({ url: web })).code).toBe(0);
  });

  it('prints its usage for unknown commands', () => {
    const r = run('config-key', 'src-tauri/tauri.conf.json');
    expect(r.code).toBe(2);
    expect(r.err).toContain('usage:');
  });
});
