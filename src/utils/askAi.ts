// "Ask AI" in the Config Editor: the question the AI panel gets about the
// selected lines (or the whole tab). Pure, so it is unit-tested. The text
// handed in here already has its secrets hidden; the editor keeps the
// originals to put back when the AI's answer is reviewed as a diff.

import type { LineSpan } from './sendSelection';

export type AskKind = 'explain' | 'check' | 'convert' | 'fix' | 'custom';

const VENDOR_LABELS: Record<string, string> = {
  'aruba-cx': 'Aruba CX',
  'aruba-aos-s': 'Aruba AOS-S',
  'aruba-ap': 'Aruba Instant AP',
  'aruba-controller': 'ArubaOS 8 controller',
  'juniper-junos': 'Junos',
  mist: 'Junos (Mist-managed switch)',
  generic: 'device config',
};

export function languageLabel(language: string, fallback?: string): string {
  return VENDOR_LABELS[language] ?? fallback ?? language;
}

/** The vendor "Convert" goes to: Aruba ↔ Junos. */
export function otherVendor(language: string): { id: string; label: string } | null {
  if (language === 'aruba-cx' || language === 'aruba-aos-s') return { id: 'juniper-junos', label: 'Junos' };
  if (language === 'juniper-junos' || language === 'mist') return { id: 'aruba-cx', label: 'Aruba CX' };
  return null;
}

export interface AskMenuItem {
  kind: AskKind;
  label: string;
}

export function askMenu(language: string, hasProblems: boolean): AskMenuItem[] {
  const other = otherVendor(language);
  return [
    { kind: 'explain', label: 'Explain these lines' },
    { kind: 'check', label: 'Check them for mistakes' },
    ...(hasProblems ? [{ kind: 'fix' as const, label: 'Fix the problems found' }] : []),
    ...(other ? [{ kind: 'convert' as const, label: `Convert to ${other.label}` }] : []),
    { kind: 'custom', label: 'Ask something else…' },
  ];
}

export interface AskInput {
  kind: AskKind;
  /** The user's own question (Ask something else). */
  question?: string;
  /** The lines, secrets already hidden. */
  text: string;
  language: string;
  /** Shown name of the language (code tabs: "YAML", "Python" …). */
  languageName?: string;
  tabName: string;
  /** null: the whole tab. */
  span: LineSpan | null;
  hidden: number;
  /** The problems GreenCLI found in these lines (Fix, Check). */
  problems?: Array<{ lineNumber: number; message: string }>;
}

function questionFor(input: AskInput, vendor: string): string {
  switch (input.kind) {
    case 'explain':
      return `Explain what these ${vendor} lines do, in plain words. Go line by line where it helps.`;
    case 'check':
      return `Check these ${vendor} lines for mistakes, risky commands and anything missing. Say what you would change and why.`;
    case 'fix':
      return `Fix the problems GreenCLI found in these ${vendor} lines (listed below).`;
    case 'convert': {
      const other = otherVendor(input.language);
      return other
        ? `Convert these ${vendor} lines to ${other.label}. Say what has no direct match.`
        : `Convert these ${vendor} lines.`;
    }
    default:
      return input.question?.trim() || `What do these ${vendor} lines do?`;
  }
}

export function buildAskPrompt(input: AskInput): string {
  const vendor = languageLabel(input.language, input.languageName);
  const where = input.span
    ? input.span.start === input.span.end
      ? `line ${input.span.start}`
      : `lines ${input.span.start}–${input.span.end}`
    : 'the whole tab';
  const fence = input.text.includes('```') ? '~~~' : '```';
  const replyLanguage = input.kind === 'convert' ? (otherVendor(input.language)?.id ?? input.language) : input.language;
  const parts = [
    questionFor(input, vendor),
    `From the Config Editor: ${where} of "${input.tabName}" (${vendor})` +
      (input.hidden ? `. ${input.hidden} ${input.hidden === 1 ? 'secret is' : 'secrets are'} hidden as <secret hidden>.` : '.'),
    `${fence}${input.language}\n${input.text.replace(/\n+$/, '')}\n${fence}`,
  ];
  if (input.problems?.length) {
    parts.push(
      'Problems GreenCLI found:\n' +
        input.problems
          .slice(0, 20)
          .map((p) => `- line ${p.lineNumber}: ${p.message}`)
          .join('\n')
    );
  }
  parts.push(
    `If you change anything, give the complete new version of ${input.span ? 'these lines' : 'the tab'} in ONE \`\`\`${replyLanguage} code block. ` +
      'I review it as a diff before anything changes. Keep every <secret hidden> exactly as it is; GreenCLI puts the real value back.'
  );
  return parts.join('\n\n');
}

/**
 * The lines that had a secret, as (hidden version, original) pairs, so an AI
 * answer that kept a line can get its real value back. Only when hiding kept
 * the line count (it hides values in place); otherwise nothing is put back
 * and the marker stays, which the editor flags as an error before any send.
 */
export function secretLinePairs(original: string, hidden: string): Array<[string, string]> {
  const a = original.split('\n');
  const b = hidden.split('\n');
  if (a.length !== b.length) return [];
  const pairs: Array<[string, string]> = [];
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) pairs.push([b[i], a[i]]);
  return pairs;
}
