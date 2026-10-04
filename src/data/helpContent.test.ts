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

describe('help: greencli-mcp topic', () => {
  const text = () => {
    const topic = HELP_TOPICS.find((t) => t.id === 'greencli-mcp');
    expect(topic).toBeDefined();
    return [topic?.summary ?? '', ...(topic?.blocks ?? []).flatMap((b) => b.items ?? [b.text ?? ''])].join(' ');
  };

  it('says the live show commands are the one thing that talks to the app', () => {
    const t = text();
    expect(t).toContain('`list_connected_devices`');
    expect(t).toContain('`device_show`');
    expect(t).toContain('macOS and Linux');
    expect(t).toContain('not on Windows yet');
    // The old promise holds for everything else.
    expect(t).toContain('never writes a file, opens a network connection or starts a program');
  });

  it('names the three answers, both boxes and the switch', () => {
    const t = text();
    expect(t).toContain('**No**');
    expect(t).toContain('**Yes, this once**');
    expect(t).toContain('until GreenCLI closes');
    expect(t).toMatch(/Casper asks first/);
    expect(t).toMatch(/two boxes/);
    expect(t).toContain('Let AI tools outside GreenCLI ask to run show commands');
    expect(t).toContain('16 KB');
    expect(t).toContain('60 seconds');
  });

  it('describes the box by its buttons, never as number keys or "each time"', () => {
    const t = text();
    expect(t).toContain('**Yes, show commands on <device> until GreenCLI closes**');
    expect(t).not.toMatch(/each time/);
    expect(t).not.toMatch(/\b1 No\b|\b2 Yes\b|\b3 Yes\b/);
  });

  it('says regex works in a filter, and which characters never do', () => {
    const t = text();
    expect(t).toContain('`^ $ * . ( ) [ ] +`');
    expect(t).toMatch(/`\?`/);
  });

  it('says plainly that a filter can give away a secret one guess at a time', () => {
    expect(text()).toMatch(/filter[^.]*one guess at a time/);
  });
});
