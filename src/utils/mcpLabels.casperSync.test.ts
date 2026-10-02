// mcpLabels.ts is a copy of Casper's src/capabilities/labels.ts, with its two
// type-only imports pointed at ./mcpTypes. With a Casper checkout at CASPER_DIR
// or ../casper this test checks the copy still matches; without one (CI) it is
// skipped.
//
// Re-copy after a Casper change:
//   CASPER_SYNC_WRITE=1 npx vitest run src/utils/mcpLabels.casperSync.test.ts

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const TARGET = resolve(process.cwd(), 'src/utils/mcpLabels.ts');
const CASPER = resolve(process.env.CASPER_DIR ?? resolve(process.cwd(), '../casper'));
const SOURCE = resolve(CASPER, 'src/capabilities/labels.ts');
const BODY_MARK = '// ---- casper source below ----\n';

const CASPER_IMPORTS =
  'import type { CapabilitySafety } from "./broker";\nimport type { MCPTool } from "../mcp/manager";\n';
const GREENCLI_IMPORT = 'import type { CapabilitySafety, MCPTool } from "./mcpTypes";\n';

/** Casper's file as GreenCLI keeps it: the two type-only imports point at ./mcpTypes. */
function forGreenCli(source: string): string {
  if (source.split(CASPER_IMPORTS).length !== 2) {
    throw new Error("Casper's labels.ts changed shape: update forGreenCli() in mcpLabels.casperSync.test.ts");
  }
  return source.replace(CASPER_IMPORTS, GREENCLI_IMPORT);
}

function header(commit: string): string {
  return (
    `// Copied from casper src/capabilities/labels.ts @ ${commit}. Do not edit here: change Casper, re-copy.\n` +
    '// Changed here: the two type-only imports point at ./mcpTypes.\n' +
    BODY_MARK
  );
}

const haveCasper = existsSync(SOURCE);

describe.skipIf(!haveCasper)("copy of Casper's tool labels", () => {
  it('mcpLabels.ts matches Casper', () => {
    const expected = forGreenCli(readFileSync(SOURCE, 'utf8'));
    if (process.env.CASPER_SYNC_WRITE === '1') {
      const commit = execFileSync('git', ['-C', CASPER, 'rev-parse', '--short', 'HEAD'], { encoding: 'utf8' }).trim();
      writeFileSync(TARGET, header(commit) + expected);
    }
    const copy = existsSync(TARGET) ? readFileSync(TARGET, 'utf8') : '';
    const at = copy.indexOf(BODY_MARK);
    expect(at, `missing "${BODY_MARK.trim()}" line`).toBeGreaterThanOrEqual(0);
    expect(copy.slice(at + BODY_MARK.length)).toBe(expected);
  });
});
