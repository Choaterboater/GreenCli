// "Copy with secrets hidden" in the Config Editor: the same filter the AI gets,
// run on the whole tab, so a config can go into a ticket, chat or email.
// Fails closed like forAi.ts: if the filter can't run, nothing is copied.

import { secretFilterSupported } from './support';
import { MAX_SCRUB_CHARS } from './forAi';
import { KIND_WORDS } from './patterns';

export type HiddenCopy =
  | { ok: true; text: string; hidden: number; message: string }
  | { ok: false; message: string };

export async function hideSecretsForCopy(text: string): Promise<HiddenCopy> {
  if (text.length > MAX_SCRUB_CHARS) {
    return { ok: false, message: 'Not copied: the tab is too big to check for secrets (over 1 MB).' };
  }
  try {
    if (!secretFilterSupported()) throw new Error('secret filter unsupported');
    const engine = await import('./engine');
    // cutHead: a tab can hold a piece cut from the middle of a config (a
    // selection from a session), so a first line may sit inside a RADIUS or
    // SNMP block. It only ever hides more.
    const result = engine.scrubForAi(text, { cutHead: true });
    const words = result.kinds.map((kind) => KIND_WORDS[kind]);
    const message = result.hidden
      ? `Copied with ${result.hidden} ${result.hidden === 1 ? 'secret' : 'secrets'} hidden${words.length ? ` (${words.join(', ')})` : ''}`
      : 'Copied: no secrets found';
    return { ok: true, text: result.text, hidden: result.hidden, message };
  } catch {
    return { ok: false, message: 'Not copied: GreenCLI could not check this text for secrets on this system.' };
  }
}
