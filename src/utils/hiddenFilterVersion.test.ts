// greencli-mcp serves configs only from hidden copies stamped with
// HIDDEN_COPY_FILTER. When the secret filter in src/utils/secrets changes (a
// Casper sync), old copies must be made again, so the version must go up.
// This test hashes the filter's source files (not its tests) and fails until
// the new hash is recorded AND the version is bumped:
//
//   1. Append the hash this test prints to HIDDEN_COPY_FILTER_SOURCES in
//      configArchive.ts, and to RECORDED below (never replace an entry).
//   2. Set HIDDEN_COPY_FILTER in configArchive.ts to that list's length.
//   3. Set HIDDEN_COPY_FILTER in src-tauri/greencli-mcp/src/lib.rs to the same
//      number (tests/identity.rs fails until they match).

import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';
import { describe, expect, it } from 'vitest';
import { HIDDEN_COPY_FILTER, HIDDEN_COPY_FILTER_SOURCES } from './configArchive';

const SECRETS = resolve(process.cwd(), 'src/utils/secrets');

/** Tests don't change what the filter does, so they are left out. */
const isTestFile = (name: string) => /\.(test|spec)\.tsx?$/.test(name);

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return files(path);
    return isTestFile(name) ? [] : [path];
  });
}

/** sha256 over each filter source file (not tests), sorted by path:
 *  "<path>\n<text with LF newlines>\n". */
function secretFilterHash(): string {
  const hash = createHash('sha256');
  const paths = files(SECRETS)
    .map((p) => relative(SECRETS, p).split(sep).join('/'))
    .sort();
  for (const path of paths) {
    const text = readFileSync(join(SECRETS, path), 'utf8').replace(/\r\n/g, '\n');
    hash.update(`${path}\n${text}\n`);
  }
  return hash.digest('hex');
}

/** Hashes of every filter version already shipped (entry N-1 = version N;
 *  version 1 came with GreenCLI 2.0). Hidden copies on users' disks carry
 *  these versions: only ever append. */
const RECORDED = ['42f0b17bb9343b571edd878f15f0e713186fea8fce11f34f9dc75825822cc15f'] as const;

describe('hidden copy filter version', () => {
  it('the secret filter has not changed since its hash was recorded', () => {
    const now = secretFilterHash();
    expect(now).toMatch(/^[0-9a-f]{64}$/);
    if (HIDDEN_COPY_FILTER_SOURCES.at(-1) !== now) {
      throw new Error(
        `The secret filter changed. Append New hash: ${now} to HIDDEN_COPY_FILTER_SOURCES and to RECORDED in ` +
          'hiddenFilterVersion.test.ts (never replace an entry), set HIDDEN_COPY_FILTER to its length, and bump ' +
          'HIDDEN_COPY_FILTER in greencli-mcp/src/lib.rs.'
      );
    }
  });

  it('has one recorded hash per filter version', () => {
    if (HIDDEN_COPY_FILTER_SOURCES.length !== HIDDEN_COPY_FILTER) {
      throw new Error(
        `HIDDEN_COPY_FILTER is ${HIDDEN_COPY_FILTER} but HIDDEN_COPY_FILTER_SOURCES has ${HIDDEN_COPY_FILTER_SOURCES.length} hashes. ` +
          'Set HIDDEN_COPY_FILTER to the list length, and bump HIDDEN_COPY_FILTER in greencli-mcp/src/lib.rs to match.'
      );
    }
    expect(new Set(HIDDEN_COPY_FILTER_SOURCES).size).toBe(HIDDEN_COPY_FILTER_SOURCES.length);
    for (const hash of HIDDEN_COPY_FILTER_SOURCES) expect(hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('keeps the recorded hashes: new ones are appended, never swapped in', () => {
    expect(
      HIDDEN_COPY_FILTER_SOURCES.slice(0, RECORDED.length),
      'HIDDEN_COPY_FILTER_SOURCES must start with every recorded hash: append new hashes, never replace one'
    ).toEqual(RECORDED);
    expect(
      HIDDEN_COPY_FILTER_SOURCES.length,
      'add the new hash to RECORDED in this test in the same commit as the version bump'
    ).toBe(RECORDED.length);
  });

  it('leaves the filter tests out of the hash', () => {
    expect(isTestFile('engine.test.ts')).toBe(true);
    expect(isTestFile('casperSync.spec.ts')).toBe(true);
    expect(isTestFile('engine.ts')).toBe(false);
    expect(isTestFile('forCopy.ts')).toBe(false);
  });
});
