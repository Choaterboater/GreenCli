// greencli-mcp serves configs only from hidden copies stamped with
// HIDDEN_COPY_FILTER. When the secret filter in src/utils/secrets changes (a
// Casper sync), old copies must be made again, so the version must go up.
// This test hashes the filter's source files (not its tests) and fails until
// the version is bumped.
//
// After bumping HIDDEN_COPY_FILTER here and in greencli-mcp, put the hash this
// test prints into HIDDEN_COPY_FILTER_SOURCE.

import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';
import { describe, expect, it } from 'vitest';
import { HIDDEN_COPY_FILTER_SOURCE } from './configArchive';

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

describe('hidden copy filter version', () => {
  it('the secret filter has not changed since HIDDEN_COPY_FILTER was set', () => {
    const now = secretFilterHash();
    if (now !== HIDDEN_COPY_FILTER_SOURCE) {
      throw new Error(
        'The secret filter changed. Bump HIDDEN_COPY_FILTER here and in greencli-mcp, then update HIDDEN_COPY_FILTER_SOURCE. ' +
          `New hash: ${now}`
      );
    }
    expect(now).toMatch(/^[0-9a-f]{64}$/);
  });

  it('leaves the filter tests out of the hash', () => {
    expect(isTestFile('engine.test.ts')).toBe(true);
    expect(isTestFile('casperSync.spec.ts')).toBe(true);
    expect(isTestFile('engine.ts')).toBe(false);
    expect(isTestFile('forCopy.ts')).toBe(false);
  });
});
