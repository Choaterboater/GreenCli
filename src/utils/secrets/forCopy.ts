// "Copy with secrets hidden" in the Config Editor: the same filter the AI gets,
// run on the whole tab, so a config can go into a ticket, chat or email.
// Fails closed like forAi.ts: if the filter can't run, nothing is copied.

import { secretFilterSupported } from './support';
import { MAX_SCRUB_CHARS } from './forAi';
import { KIND_WORDS } from './patterns';

export type HiddenCopy =
  | { ok: true; text: string; hidden: number; message: string }
  | { ok: false; message: string };

export type HiddenText =
  | { ok: true; text: string; hidden: number; words: string[] }
  | { ok: false; reason: 'too-big' | 'unsupported' };

/** Editor text with its secrets hidden (Copy with secrets hidden, Ask AI). Fails closed. */
export async function hideSecretsInText(text: string): Promise<HiddenText> {
  if (text.length > MAX_SCRUB_CHARS) return { ok: false, reason: 'too-big' };
  try {
    if (!secretFilterSupported()) throw new Error('secret filter unsupported');
    const engine = await import('./engine');
    // cutHead: a tab can hold a piece cut from the middle of a config (a
    // selection from a session), so a first line may sit inside a RADIUS or
    // SNMP block. It only ever hides more.
    const result = engine.scrubForAi(text, { cutHead: true });
    return { ok: true, text: result.text, hidden: result.hidden, words: result.kinds.map((kind) => KIND_WORDS[kind]) };
  } catch {
    return { ok: false, reason: 'unsupported' };
  }
}

export async function hideSecretsForCopy(text: string): Promise<HiddenCopy> {
  const result = await hideSecretsInText(text);
  if (!result.ok) {
    return {
      ok: false,
      message:
        result.reason === 'too-big'
          ? 'Not copied: the tab is too big to check for secrets (over 1 MB).'
          : 'Not copied: GreenCLI could not check this text for secrets on this system.',
    };
  }
  const { hidden, words } = result;
  const message = hidden
    ? `Copied with ${hidden} ${hidden === 1 ? 'secret' : 'secrets'} hidden${words.length ? ` (${words.join(', ')})` : ''}`
    : 'Copied: no secrets found';
  return { ok: true, text: result.text, hidden, message };
}
