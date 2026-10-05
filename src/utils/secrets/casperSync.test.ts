// patterns.ts, prose.ts, assignments.ts and scrub.ts in this folder are copies
// of Casper's src/secrets files (scrub.ts without its file-read rules). With a
// Casper checkout at CASPER_DIR or ../casper this test checks the copies still
// match; without one (CI) it is skipped.
//
// Re-copy after a Casper change:
//   CASPER_SYNC_WRITE=1 npx vitest run src/utils/secrets/casperSync.test.ts

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = resolve(process.cwd(), 'src/utils/secrets');
const CASPER = resolve(process.env.CASPER_DIR ?? resolve(process.cwd(), '../casper'));
const SOURCE = resolve(CASPER, 'src/secrets');
const FILES = ['patterns.ts', 'prose.ts', 'assignments.ts', 'scrub.ts'];
const BODY_MARK = '// ---- casper source below ----\n';

/** Casper's file with LF line ends: a Windows checkout made before Casper's .gitattributes has CRLF. */
function readLf(file: string): string {
  return readFileSync(file, 'utf8').replace(/\r\n/g, '\n');
}

/** Casper's file as GreenCLI keeps it. scrub.ts loses the node:path import and
 *  the file-read rules (CODE_EXTENSIONS … shouldScrubRead): there are no file reads here. */
function forGreenCli(file: string, source: string): string {
  if (file !== 'scrub.ts') return source;
  const pathImport = 'import path from "node:path";\n';
  const from = source.indexOf('const CODE_EXTENSIONS');
  const to = source.indexOf('/** bash and grep output is scrubbed only');
  if (!source.startsWith(pathImport) || from < 0 || to < from) {
    throw new Error("Casper's scrub.ts changed shape: update forGreenCli() in casperSync.test.ts");
  }
  return source.slice(pathImport.length, from) + source.slice(to);
}

function header(file: string, commit: string): string {
  const note =
    file === 'scrub.ts'
      ? '// Left out here: the node:path import and the file-read rules (CODE_EXTENSIONS … shouldScrubRead).\n'
      : '';
  return `// Copied from casper src/secrets/${file} @ ${commit}. Do not edit here: change Casper, re-copy.\n${note}${BODY_MARK}`;
}

const haveCasper = existsSync(resolve(SOURCE, 'scrub.ts'));

describe.skipIf(!haveCasper)('copies of Casper secret rules', () => {
  for (const file of FILES) {
    it(`${file} matches Casper`, () => {
      const expected = forGreenCli(file, readLf(resolve(SOURCE, file)));
      const target = resolve(HERE, file);
      if (process.env.CASPER_SYNC_WRITE === '1') {
        const commit = execFileSync('git', ['-C', CASPER, 'rev-parse', '--short', 'HEAD'], { encoding: 'utf8' }).trim();
        writeFileSync(target, header(file, commit) + expected);
      }
      const copy = existsSync(target) ? readFileSync(target, 'utf8') : '';
      const at = copy.indexOf(BODY_MARK);
      expect(at, `${file}: missing "${BODY_MARK.trim()}" line`).toBeGreaterThanOrEqual(0);
      expect(copy.slice(at + BODY_MARK.length)).toBe(expected);
    });
  }
});
