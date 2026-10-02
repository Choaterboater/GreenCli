// Reviewing an AI suggestion as a diff in the Config Editor. Pure, so it is
// unit-tested: where the lines you asked about sit now, the tab with the
// suggestion in their place, and the real secrets put back where the AI kept
// a <secret hidden> line as it was.

import type { LineSpan } from './sendSelection';

const MARKER = /<\s*(?:secret\s+hidden|line\s+hidden\s*:\s*secret)\s*>/i;

/** Put the real line back wherever the suggestion kept a hidden-secret line as it was. */
export function restoreSecrets(
  code: string,
  secretLines: ReadonlyArray<readonly [string, string]>
): { text: string; restored: number; markersLeft: number } {
  const byHidden = new Map(secretLines.map(([hidden, real]) => [hidden.trim(), real]));
  let restored = 0;
  let markersLeft = 0;
  const lines = code.split('\n').map((line) => {
    if (!MARKER.test(line)) return line;
    const real = byHidden.get(line.trim());
    if (real === undefined) {
      markersLeft++;
      return line;
    }
    restored++;
    // Keep the suggestion's indent; the rest of the line is the real one.
    return line.slice(0, line.length - line.trimStart().length) + real.trimStart();
  });
  return { text: lines.join('\n'), restored, markersLeft };
}

/** Where the lines you asked about are now: the same lines, or the same block moved. */
export function locateTarget(current: string, original: string, span: LineSpan | null): LineSpan | null {
  const lines = current.split('\n');
  if (!span) return { start: 1, end: lines.length };
  const want = original.split('\n');
  const at = (start: number) => want.every((line, i) => lines[start - 1 + i] === line);
  if (span.start + want.length - 1 <= lines.length && at(span.start)) return { start: span.start, end: span.start + want.length - 1 };
  for (let start = 1; start + want.length - 1 <= lines.length; start++) {
    if (at(start)) return { start, end: start + want.length - 1 };
  }
  return null;
}

/** The tab with the suggestion in place of those lines. */
export function withSuggestion(current: string, span: LineSpan, suggestion: string): string {
  const lines = current.split('\n');
  const whole = span.start === 1 && span.end === lines.length;
  // A code block has no trailing newline; keep the tab's own.
  let block = suggestion.replace(/\n+$/, '');
  if (whole && current.endsWith('\n')) block += '\n';
  if (whole) return block;
  return [...lines.slice(0, span.start - 1), ...block.split('\n'), ...lines.slice(span.end)].join('\n');
}

// Code-fence names the AI may use for device configs.
const FENCE_LANGUAGES: Record<string, string> = {
  'juniper-junos': 'juniper-junos',
  junos: 'juniper-junos',
  juniper: 'juniper-junos',
  mist: 'mist',
  'aruba-cx': 'aruba-cx',
  arubacx: 'aruba-cx',
  aoscx: 'aruba-cx',
  'aos-cx': 'aruba-cx',
  'aruba-aos-s': 'aruba-aos-s',
  aoss: 'aruba-aos-s',
  'aos-s': 'aruba-aos-s',
};

/** The device language a code block is fenced as, if any. */
export function fenceDeviceLanguage(fence: string | undefined): string | undefined {
  return fence ? FENCE_LANGUAGES[fence.toLowerCase()] : undefined;
}

/** A suggestion for another vendor (Convert): it goes to a new tab, not over your lines. */
export function isOtherVendor(fence: string | undefined, tabLanguage: string): boolean {
  const family = (id: string) => (id === 'mist' ? 'juniper-junos' : id);
  const lang = fenceDeviceLanguage(fence);
  return !!lang && !!fenceDeviceLanguage(tabLanguage) && family(lang) !== family(tabLanguage);
}
