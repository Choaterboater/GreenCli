import { beforeEach, describe, expect, it } from 'vitest';
import { MAX_DRAFT_CHARS, draftFromSelection } from './editorDraft';
import { useEditorInbox } from '../store/editorInboxStore';

describe('draftFromSelection', () => {
  it('trims padding and blank edges, and keeps the device language', () => {
    const selection = '\r\n   \r\ninterface 1/1/5      \r\n    description uplink   \r\n    no shutdown\r\n\r\n';
    expect(draftFromSelection(selection, 'core-sw1', 'aruba-cx')).toEqual({
      name: 'core-sw1 (selection)',
      content: 'interface 1/1/5\n    description uplink\n    no shutdown\n',
      language: 'aruba-cx',
    });
  });

  it('opens generic sessions as plain text and gives nothing for a blank selection', () => {
    expect(draftFromSelection('ls -la', 'bastion', 'generic')?.language).toBe('plaintext');
    expect(draftFromSelection('ls -la', 'bastion', null)?.language).toBe('plaintext');
    expect(draftFromSelection('  \n \n', 'bastion', 'aruba-cx')).toBeNull();
  });

  it('cuts a huge selection', () => {
    const draft = draftFromSelection('x'.repeat(MAX_DRAFT_CHARS + 10), 's', 'generic');
    expect(draft?.content.length).toBe(MAX_DRAFT_CHARS + 1);
  });
});

describe('editor inbox', () => {
  beforeEach(() => {
    useEditorInbox.getState().take();
  });

  it('hands drafts over once, in order', () => {
    useEditorInbox.getState().send({ name: 'a', content: '1', language: 'plaintext' });
    useEditorInbox.getState().send({ name: 'b', content: '2', language: 'aruba-cx' });
    expect(useEditorInbox.getState().take().map((d) => d.name)).toEqual(['a', 'b']);
    expect(useEditorInbox.getState().take()).toEqual([]);
  });
});
