import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';
import { describe, it, expect, vi, beforeAll, beforeEach } from 'vitest';
import ConfigEditor from './ConfigEditor';
import { useSessionStore } from '../store/sessionStore';
import { useEditorInbox } from '../store/editorInboxStore';
import { exitHolds } from '../utils/beforeExit';
import { restartToUpdate } from '../utils/updates';
import { useToastStore } from '../store/toastStore';
import { invoke } from '@tauri-apps/api/core';
import type { Session } from '../types';

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn().mockResolvedValue('') }));
vi.mock('@tauri-apps/api/event', () => ({ listen: vi.fn().mockResolvedValue(() => undefined) }));
vi.mock('@monaco-editor/react', () => ({ default: () => null, DiffEditor: () => null }));
vi.mock('../editor/setup', () => ({ setupMonaco: vi.fn() }));
const askConfirm = vi.hoisted(() => vi.fn());
vi.mock('../store/dialogStore', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../store/dialogStore')>()),
  askConfirm,
}));

const session: Session = {
  sessionId: 's1',
  connected: true,
  config: { id: 'sw1', name: 'sw1', protocol: 'ssh', host: '10.0.0.1', deviceType: 'aruba-cx' },
};

describe('ConfigEditor send and Restart to update', () => {
  beforeAll(() => {
    // jsdom has no scrollIntoView; the tab strip scrolls the active tab into view.
    Element.prototype.scrollIntoView ??= vi.fn();
  });

  beforeEach(() => {
    askConfirm.mockReset();
    vi.mocked(invoke).mockClear();
    useToastStore.getState().clear();
    useSessionStore.setState({ showConfigEditor: true, sessions: [session], activeSessionId: 's1' });
    useEditorInbox.setState({ pending: [] });
  });

  it('holds the exit from the Send confirm until the send ends', async () => {
    let answer: (ok: boolean) => void = () => {};
    askConfirm.mockImplementation(() => new Promise<boolean>((r) => (answer = r)));
    render(<ConfigEditor />);
    act(() => {
      useEditorInbox.getState().send({ name: 'vlans', content: 'vlan 10\n  name users\n', language: 'aruba-cx' });
    });
    const send = await screen.findByTitle('Send lines to terminal');
    await waitFor(() => expect((send as HTMLButtonElement).disabled).toBe(false));

    expect(exitHolds()).toEqual([]);
    fireEvent.click(send);
    await waitFor(() => expect(askConfirm).toHaveBeenCalled());
    expect(exitHolds()).toEqual(['A config send is running.']);

    // Restart to update says "Not now" without asking or installing.
    await expect(restartToUpdate('2.0.1')).resolves.toBe(false);
    expect(askConfirm).toHaveBeenCalledTimes(1);
    expect(vi.mocked(invoke)).not.toHaveBeenCalledWith('update_install');
    const [t] = useToastStore.getState().toasts;
    expect(t.title).toBe('Not now');
    expect(t.message).toContain('A config send is running.');

    await act(async () => answer(false));
    await waitFor(() => expect(exitHolds()).toEqual([]));
  });
});
