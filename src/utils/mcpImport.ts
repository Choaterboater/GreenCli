// The words for importing MCP servers set up elsewhere (Casper, Claude Code,
// ~/.mcp.json, VS Code). The scan and the import itself are in Rust
// (src-tauri/src/mcp/import.rs); nothing here ever sees an env, header or
// argument value.
import type { DialogChoice } from '../store/dialogStore';
import type { McpImportItem, McpImportOutcome, McpImportPreview } from './mcpTypes';

export interface ImportDialogText {
  title: string;
  message: string;
  notes: string[];
  details?: string;
  detailsLabel?: string;
  choices: DialogChoice[];
}

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;

function joinWords(words: string[]): string {
  if (words.length <= 1) return words[0] ?? '';
  return `${words.slice(0, -1).join(', ')} and ${words[words.length - 1]}`;
}

/** What GreenCLI says about one server: its pins, the values it needs and notes. */
function itemPhrases(item: McpImportItem): string[] {
  const phrases: string[] = [];
  if (item.pins.kind === 'pinned') {
    phrases.push(`read-only setting added at Connect: ${item.pins.shown.join(', ')}`);
  } else if (item.pins.kind === 'cannot-pin') {
    phrases.push(item.preset ? `${item.preset}, ${item.pins.reason}` : item.pins.reason);
  }
  if (item.needs.length) phrases.push(`needs ${item.needs.join(', ')}; add it with Edit`);
  phrases.push(...item.notes);
  return phrases;
}

const NOT_STARTED = (one: boolean) => `${one ? 'It comes' : 'Each comes'} in with writes off and is not started.`;

/** The first dialog: 1 Not now, 2 Import all, 3 Pick which. */
export function importDialog(preview: McpImportPreview): ImportDialogText {
  const items = preview.items;
  const one = items.length === 1;
  const sources = [...new Set(items.map((i) => i.source))];
  const notes: string[] = [];
  for (const item of items) {
    const phrases = itemPhrases(item);
    const head = `${item.name} (${item.source})`;
    if (phrases.length === 0) notes.push(head);
    for (const phrase of phrases) notes.push(`${head}: ${phrase}`);
  }
  for (const skip of preview.skipped) notes.push(`${skip.name} (${skip.source}): skipped, ${skip.reason}`);
  notes.push(...preview.problems);
  const choices: DialogChoice[] = [
    { value: 'no', label: 'Not now', detail: 'Nothing changes. Import is in MCP Servers any time.', tone: 'plain' },
    {
      value: 'all',
      label: one ? 'Import it' : 'Import all',
      detail: one ? 'Writes off. Click Connect when you want it.' : 'Writes off. Connect each one when you want it.',
      tone: 'accent',
    },
  ];
  if (!one) choices.push({ value: 'pick', label: 'Pick which…', detail: 'Choose one at a time', tone: 'plain' });
  return {
    title: 'Use MCP servers you already set up?',
    message: `GreenCLI found ${plural(items.length, 'server')} in ${joinWords(sources)}. ${NOT_STARTED(one)}`,
    notes,
    details: items.map((i) => `${i.name}: ${i.runs}`).join('\n'),
    detailsLabel: 'What each one runs',
    choices,
  };
}

/** One server under Pick which: 1 Skip, 2 Import. `index` counts from 0. */
export function pickDialog(item: McpImportItem, index: number, total: number): ImportDialogText {
  return {
    title: `Import ${item.name}?`,
    message: `From ${item.source} (${index + 1} of ${total}). ${NOT_STARTED(true)}`,
    notes: itemPhrases(item),
    details: item.runs,
    detailsLabel: 'What it runs',
    choices: [
      { value: 'skip', label: 'Skip', tone: 'plain' },
      { value: 'import', label: 'Import', tone: 'accent' },
    ],
  };
}

/** The toasts after an import. */
export function importDoneText(
  outcome: McpImportOutcome,
  items: McpImportItem[],
): { title: string; detail: string; needs: string[]; skipped: string[] } {
  const needs = outcome.added
    .map((name) => items.find((i) => i.name === name))
    .filter((i): i is McpImportItem => !!i && i.needs.length > 0)
    .map((i) => `${i.name} needs ${i.needs.join(', ')}. Click Edit to add it.`);
  return {
    title: `${plural(outcome.added.length, 'MCP server')} imported`,
    detail: 'Writes are off. Click Connect when you want one.',
    needs,
    skipped: outcome.skipped.map(([name, reason]) => `${name}: ${reason}`),
  };
}
