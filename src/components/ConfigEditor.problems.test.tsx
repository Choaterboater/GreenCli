import { render, screen, fireEvent, act } from '@testing-library/react';
import { describe, it, expect, vi, beforeAll, beforeEach } from 'vitest';
import ConfigEditor from './ConfigEditor';
import { useSessionStore } from '../store/sessionStore';
import { useEditorInbox } from '../store/editorInboxStore';

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn().mockResolvedValue('') }));
vi.mock('@tauri-apps/api/event', () => ({ listen: vi.fn().mockResolvedValue(() => undefined) }));
vi.mock('@monaco-editor/react', () => ({ default: () => null, DiffEditor: () => null }));
vi.mock('../editor/setup', () => ({ setupMonaco: vi.fn() }));

function open(name: string, content: string, language: string) {
  render(<ConfigEditor />);
  act(() => {
    useEditorInbox.getState().send({ name, content, language });
  });
}

describe('ConfigEditor problems badge', () => {
  beforeAll(() => {
    // jsdom has no scrollIntoView; the tab strip scrolls the active tab into view.
    Element.prototype.scrollIntoView ??= vi.fn();
  });

  beforeEach(() => {
    useSessionStore.setState({ showConfigEditor: true, sessions: [], activeSessionId: null });
    useEditorInbox.setState({ pending: [] });
  });

  it('shows No problems on a clean device config, and opens the Problems panel on click', async () => {
    open('sw1.cfg', 'vlan 10\n  name users\n', 'aruba-cx');
    const button = await screen.findByRole('button', { name: 'Problems: none' });
    expect(button.textContent).toContain('No problems');
    expect(screen.queryByRole('region', { name: 'Problems' })).toBeNull();

    fireEvent.click(button);
    expect(button.getAttribute('aria-pressed')).toBe('true');
    expect(screen.getByRole('region', { name: 'Problems' }).textContent).toContain('No problems in this tab.');

    fireEvent.click(button);
    expect(screen.queryByRole('region', { name: 'Problems' })).toBeNull();
  });

  it('keeps the counts when there is a problem', async () => {
    open('sw1.cfg', 'reload\n', 'aruba-cx');
    const button = await screen.findByRole('button', { name: /^Problems: 1 warning/ });
    expect(button.textContent).not.toContain('No problems');
  });

  it('shows no badge on a clean code file', async () => {
    open('script.py', 'print("hi")\n', 'python');
    await screen.findByText('script.py');
    expect(screen.queryByRole('button', { name: /^Problems/ })).toBeNull();
  });

  it('shows no badge on an empty device config tab', async () => {
    open('empty.cfg', '', 'aruba-cx');
    await screen.findByText('empty.cfg');
    expect(screen.queryByRole('button', { name: /^Problems/ })).toBeNull();
  });
});
