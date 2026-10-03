import { describe, expect, it } from 'vitest';
import { HELP_TOPICS } from './helpContent';

describe('help: Updates topic', () => {
  it('names everything Restart to update warns about or waits for', () => {
    const topic = HELP_TOPICS.find((t) => t.id === 'updates');
    expect(topic).toBeDefined();
    const text = (topic?.blocks ?? []).flatMap((b) => b.items ?? [b.text ?? '']).join(' ');
    // The same list as restartToUpdate in src/utils/updates.ts.
    for (const what of [
      'open sessions will close',
      'unsaved Config Editor edits',
      'waiting for the vault to unlock',
      'AI answer is still running',
      'Change Job',
      'bulk run',
      'Config Editor send',
      'SFTP upload or download',
    ]) {
      expect(text).toContain(what);
    }
  });
});
