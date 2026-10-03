// scripts/update-signature.mjs is what release.yml runs to check update files
// before a draft release is published. These tests run it the same way, on a
// file signed like a release build signs one (the same fixture as the Rust
// test release_signatures_verify_with_the_fetched_key in updater.rs).

import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
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

describe('update-signature.mjs uploads (each build job)', () => {
  /** A bundle folder with these files (a name ending in / is a folder). */
  function bundle(files: string[]) {
    const d = tempDir();
    for (const f of files) {
      const p = join(d, f);
      if (f.endsWith('/')) {
        mkdirSync(p, { recursive: true });
      } else {
        mkdirSync(join(p, '..'), { recursive: true });
        writeFileSync(p, 'x');
      }
    }
    return d;
  }
  function conf(version = '2.0.1') {
    const f = join(tempDir(), 'tauri.conf.json');
    writeFileSync(f, JSON.stringify({ productName: 'GreenCLI', version }));
    return f;
  }
  function uploads(dir: string, target: string, version = '2.0.1') {
    const r = run('uploads', dir, target, conf(version));
    const lines = r.out.split('\n').filter((l) => l.length > 0);
    return { ...r, rows: lines.map((l) => l.split('\t')) };
  }

  const MAC = [
    'dmg/GreenCLI_2.0.1_aarch64.dmg',
    'macos/GreenCLI.app/Contents/MacOS/GreenCLI',
    'macos/GreenCLI.app.tar.gz',
    'macos/GreenCLI.app.tar.gz.sig',
  ];
  const WINDOWS = [
    'msi/GreenCLI_2.0.1_x64_en-US.msi',
    'msi/GreenCLI_2.0.1_x64_en-US.msi.sig',
    'nsis/GreenCLI_2.0.1_x64-setup.exe',
    'nsis/GreenCLI_2.0.1_x64-setup.exe.sig',
  ];

  it('names the Mac files as tauri-action did, each update file with its .sig', () => {
    const d = bundle(MAC);
    const r = uploads(d, 'aarch64-apple-darwin');
    expect(r.err).toBe('');
    expect(r.code).toBe(0);
    // Not the GreenCLI.app folder: the update file holds it.
    expect(r.rows).toEqual([
      [`${d}/dmg/GreenCLI_2.0.1_aarch64.dmg`, 'GreenCLI_2.0.1_aarch64.dmg', 'GreenCLI_2.0.1_aarch64.dmg'],
      [
        `${d}/macos/GreenCLI.app.tar.gz`,
        'GreenCLI_2.0.1_aarch64.app.tar.gz',
        'GreenCLI_2.0.1_aarch64.app.tar.gz',
      ],
      [
        `${d}/macos/GreenCLI.app.tar.gz.sig`,
        'GreenCLI_2.0.1_aarch64.app.tar.gz.sig',
        'GreenCLI_2.0.1_aarch64.app.tar.gz.sig',
      ],
    ]);
    const intel = uploads(bundle(['dmg/GreenCLI_2.0.1_x64.dmg', ...MAC.slice(1)]), 'x86_64-apple-darwin');
    expect(intel.rows.map((row) => row[1])).toEqual([
      'GreenCLI_2.0.1_x64.dmg',
      'GreenCLI_2.0.1_x64.app.tar.gz',
      'GreenCLI_2.0.1_x64.app.tar.gz.sig',
    ]);
  });

  it('keeps the Windows file names, and leaves other files out', () => {
    const d = bundle([...WINDOWS, 'msi/GreenCLI_2.0.1_x64_de-DE.msi', 'nsis/notes.txt', 'msi/sub/']);
    const r = uploads(d, 'x86_64-pc-windows-msvc');
    expect(r.err).toBe('');
    expect(r.rows.map((row) => row[0])).toEqual([
      `${d}/msi/GreenCLI_2.0.1_x64_de-DE.msi`,
      ...WINDOWS.map((f) => `${d}/${f}`),
    ]);
    for (const [path, name, label] of r.rows) {
      expect(name).toBe(path.slice(path.lastIndexOf('/') + 1));
      expect(label).toBe(name);
    }
  });

  it('gives latest-json the names it looks for, for every platform', () => {
    const builds = [
      uploads(bundle(['dmg/GreenCLI_2.0.1_aarch64.dmg', ...MAC.slice(1)]), 'aarch64-apple-darwin'),
      uploads(bundle(['dmg/GreenCLI_2.0.1_x64.dmg', ...MAC.slice(1)]), 'x86_64-apple-darwin'),
      uploads(bundle(WINDOWS), 'x86_64-pc-windows-msvc'),
    ];
    const names = builds.flatMap((b) => b.rows.map((row) => row[1]));
    const assets = names.map((name, i) => ({ id: i + 1, name }));
    const signed = names.filter((n) => names.includes(`${n}.sig`));
    const r = latestJson(assets, sigDir(signed));
    expect(r.err).toBe('');
    expect(r.code).toBe(0);
    expect(Object.keys(JSON.parse(r.out).platforms).sort()).toEqual([
      'darwin-aarch64',
      'darwin-aarch64-app',
      'darwin-x86_64',
      'darwin-x86_64-app',
      'windows-x86_64',
      'windows-x86_64-msi',
      'windows-x86_64-nsis',
    ]);
  });

  it("uses GitHub's name rule, with the name from before it as the label", () => {
    const d = bundle(['macos/Green CLI.app.tar.gz', 'nsis/Green..CLI_2.0.1_x64-setup.exe']);
    const r = uploads(d, 'aarch64-apple-darwin');
    expect(r.err).toBe('');
    expect(r.rows.map((row) => row.slice(1))).toEqual([
      ['Green.CLI_2.0.1_aarch64.app.tar.gz', 'Green%20CLI_2.0.1_aarch64.app.tar.gz'],
      ['Green.CLI_2.0.1_x64-setup.exe', 'Green..CLI_2.0.1_x64-setup.exe'],
    ]);
  });

  it('fails with no files, a version that is not plain, or two files of one name', () => {
    expect(uploads(bundle(['macos/GreenCLI.app/']), 'aarch64-apple-darwin').err).toContain('No installers under');
    const bad = uploads(bundle(MAC), 'aarch64-apple-darwin', '2.0.1+5');
    expect(bad.err).toContain('not a plain version');
    expect(bad.out).toBe('');
    const two = uploads(bundle(['nsis/A b-setup.exe', 'nsis/A.b-setup.exe']), 'x86_64-pc-windows-msvc');
    expect(two.code).toBe(1);
    expect(two.err).toContain('would both be A.b-setup.exe in the release');
    expect(run('uploads', tempDir(), 'aarch64-apple-darwin').err).toContain('usage:');
  });
});

/**
 * A release's assets after the three build jobs: each update file, its .sig
 * and the rest. One job writes latest.json from them (update-files), so two
 * builds that finish together can't drop each other's entries.
 */
const RELEASE_ASSETS = [
  { id: 101, name: 'GreenCLI_2.0.1_aarch64.dmg' },
  { id: 102, name: 'GreenCLI_2.0.1_aarch64.app.tar.gz' },
  { id: 103, name: 'GreenCLI_2.0.1_aarch64.app.tar.gz.sig' },
  { id: 201, name: 'GreenCLI_2.0.1_x64.dmg' },
  { id: 202, name: 'GreenCLI_2.0.1_x64.app.tar.gz' },
  { id: 203, name: 'GreenCLI_2.0.1_x64.app.tar.gz.sig' },
  { id: 301, name: 'GreenCLI_2.0.1_x64_en-US.msi' },
  { id: 302, name: 'GreenCLI_2.0.1_x64_en-US.msi.sig' },
  // A second WiX language: the bundler signs only the first one's .msi.
  { id: 303, name: 'GreenCLI_2.0.1_x64_de-DE.msi' },
  { id: 304, name: 'GreenCLI_2.0.1_x64-setup.exe' },
  { id: 305, name: 'GreenCLI_2.0.1_x64-setup.exe.sig' },
  { id: 401, name: 'update-key-darwin-aarch64.pub' },
  { id: 402, name: 'update-key-darwin-x86_64.pub' },
  { id: 403, name: 'update-key-windows-x86_64.pub' },
];
const UPDATE_FILE_NAMES = RELEASE_ASSETS.map((a) => a.name).filter((n) =>
  RELEASE_ASSETS.some((s) => s.name === `${n}.sig`),
);

/** The .sig assets as the update-files job downloads them. */
function sigDir(names = UPDATE_FILE_NAMES) {
  const d = tempDir();
  for (const n of names) writeFileSync(join(d, `${n}.sig`), SIGNED_SIG);
  return d;
}

function assetsFile(assets: { id: number; name: string }[]) {
  const f = join(tempDir(), 'assets.json');
  writeFileSync(f, JSON.stringify(assets));
  return f;
}

function latestJson(assets = RELEASE_ASSETS, sigs = sigDir(), version = '2.0.1') {
  return run('latest-json', assetsFile(assets), sigs, REPO, version);
}

/**
 * latest-json's output, uploaded: a release folder for check-release with
 * every update file (all signed by the fixture key) and every platform key.
 */
function releaseFromLatestJson() {
  const written = latestJson();
  expect(written.err).toBe('');
  const d = tempDir();
  writeFileSync(join(d, 'latest.json'), written.out);
  for (const n of UPDATE_FILE_NAMES) writeFileSync(join(d, n), SIGNED_DATA);
  for (const p of ['darwin-aarch64', 'darwin-x86_64', 'windows-x86_64']) {
    writeFileSync(join(d, `update-key-${p}.pub`), SIGNED_PUB);
  }
  const assets = assetsFile([...RELEASE_ASSETS, { id: 501, name: 'latest.json' }]);
  return { d, assets };
}

describe('update-signature.mjs latest-json (the update-files job)', () => {
  it('writes every platform from the signed update files, as tauri-action did', () => {
    const r = latestJson();
    expect(r.err).toBe('');
    expect(r.code).toBe(0);
    const manifest = JSON.parse(r.out);
    expect(manifest.version).toBe('2.0.1');
    expect(manifest.notes).toBe('');
    expect(new Date(manifest.pub_date).toISOString()).toBe(manifest.pub_date);
    // Each url is the file's download link in the v2.0.1 release, not its
    // API address (tauri-action's default): GitHub counts API downloads
    // against its limit of 60 requests an hour per address without a login.
    const file = (name: string) => ({
      signature: SIGNED_SIG,
      url: `https://github.com/${REPO}/releases/download/v2.0.1/${name}`,
    });
    expect(manifest.platforms).toEqual({
      'darwin-aarch64': file('GreenCLI_2.0.1_aarch64.app.tar.gz'),
      'darwin-aarch64-app': file('GreenCLI_2.0.1_aarch64.app.tar.gz'),
      'darwin-x86_64': file('GreenCLI_2.0.1_x64.app.tar.gz'),
      'darwin-x86_64-app': file('GreenCLI_2.0.1_x64.app.tar.gz'),
      // The NSIS installer is the plain Windows entry (updaterJsonPreferNsis).
      'windows-x86_64': file('GreenCLI_2.0.1_x64-setup.exe'),
      'windows-x86_64-nsis': file('GreenCLI_2.0.1_x64-setup.exe'),
      'windows-x86_64-msi': file('GreenCLI_2.0.1_x64_en-US.msi'),
    });
    for (const { url } of Object.values(manifest.platforms) as { url: string }[]) {
      expect(url).not.toContain('api.github.com');
    }
  });

  it('writes a download link that keeps an odd file name in one piece', () => {
    const odd = RELEASE_ASSETS.map((a) =>
      a.name.startsWith('GreenCLI_2.0.1_x64-setup.exe')
        ? { ...a, name: a.name.replace('GreenCLI_', 'Green CLI#_') }
        : a,
    );
    const names = odd.map((a) => a.name).filter((n) => odd.some((s) => s.name === `${n}.sig`));
    const r = latestJson(odd, sigDir(names));
    expect(r.err).toBe('');
    expect(JSON.parse(r.out).platforms['windows-x86_64'].url).toBe(
      `https://github.com/${REPO}/releases/download/v2.0.1/Green%20CLI%23_2.0.1_x64-setup.exe`,
    );
  });

  it('fails when a platform has no signed update file', () => {
    const noIntel = RELEASE_ASSETS.filter((a) => !a.name.startsWith('GreenCLI_2.0.1_x64.app'));
    expect(latestJson(noIntel).err).toContain(
      'darwin-x86_64: the release needs one signed update file for version 2.0.1 (found none)',
    );
    const unsigned = RELEASE_ASSETS.filter((a) => a.name !== 'GreenCLI_2.0.1_x64-setup.exe.sig');
    expect(latestJson(unsigned).err).toContain('windows-x86_64: the release needs one signed update file');
    // Files of another version don't count.
    expect(latestJson(RELEASE_ASSETS, sigDir(), '2.0.2').err).toContain('(found none)');
  });

  it('fails when a platform has two signed update files', () => {
    const two = [
      ...RELEASE_ASSETS,
      { id: 601, name: 'Other_2.0.1_aarch64.app.tar.gz' },
      { id: 602, name: 'Other_2.0.1_aarch64.app.tar.gz.sig' },
    ];
    expect(latestJson(two, sigDir([...UPDATE_FILE_NAMES, 'Other_2.0.1_aarch64.app.tar.gz'])).err).toContain(
      'darwin-aarch64: the release needs one signed update file for version 2.0.1 ' +
        '(found GreenCLI_2.0.1_aarch64.app.tar.gz, Other_2.0.1_aarch64.app.tar.gz)',
    );
  });

  it('fails when a .sig was not downloaded or the version is not plain', () => {
    const missing = UPDATE_FILE_NAMES.filter((n) => n !== 'GreenCLI_2.0.1_x64_en-US.msi');
    expect(latestJson(RELEASE_ASSETS, sigDir(missing)).err).toContain(
      'GreenCLI_2.0.1_x64_en-US.msi.sig was not downloaded',
    );
    expect(latestJson(RELEASE_ASSETS, sigDir(), '2.0.1+5').err).toContain('not a plain version');
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

  it('passes the latest.json that latest-json writes, with every platform', () => {
    const r = releaseFromLatestJson();
    const all = [
      'darwin-aarch64',
      'darwin-aarch64-app',
      'darwin-x86_64',
      'darwin-x86_64-app',
      'windows-x86_64',
      'windows-x86_64-msi',
      'windows-x86_64-nsis',
    ];
    const ok = run('check-release', r.d, r.assets, REPO, 'v2.0.1', ...all);
    expect(ok.err).toBe('');
    expect(ok.code).toBe(0);
    expect(ok.out).toContain('ok  windows-x86_64  GreenCLI_2.0.1_x64-setup.exe');
  });

  it('prints its usage for unknown commands', () => {
    const r = run('config-key', 'src-tauri/tauri.conf.json');
    expect(r.code).toBe(2);
    expect(r.err).toContain('usage:');
  });
});
