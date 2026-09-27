import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { invoke } from '@tauri-apps/api/tauri';
import { open } from '@tauri-apps/api/dialog';
import ImportHosts from './ImportHosts';
import { useSessionStore } from '../store/sessionStore';

vi.mock('@tauri-apps/api/tauri', () => ({ invoke: vi.fn() }));
vi.mock('@tauri-apps/api/dialog', () => ({ open: vi.fn(), save: vi.fn() }));

const settings = vi.hoisted(() => ({ mistToken: '' }));
vi.mock('../store/settingsStore', () => ({
  useSettingsStore: vi.fn((selector?: (s: typeof settings) => unknown) => (selector ? selector(settings) : settings)),
}));

const CSV = 'name,host,user,folder\ncore,10.0.0.1,admin,HQ\nidf,10.0.0.2,admin,Branch\n';

describe('ImportHosts', () => {
  beforeEach(() => {
    vi.mocked(invoke).mockReset();
    useSessionStore.setState({
      showImportHosts: true,
      importHostsSource: 'csv',
      folders: [
        {
          id: 'hq',
          name: 'HQ',
          expanded: true,
          items: [{ id: 'old', name: 'core', protocol: 'ssh', host: '10.0.0.1', port: 22, username: 'admin', deviceType: 'generic' }],
        },
      ],
    });
  });

  it('previews a CSV, greys out saved hosts and saves only the new one into a new folder', async () => {
    vi.mocked(open).mockResolvedValue('/tmp/hosts.csv');
    vi.mocked(invoke).mockImplementation(async (cmd: string) => {
      if (cmd === 'read_file_text') return CSV;
      if (cmd === 'create_folder') return 'folder-new';
      return undefined;
    });

    render(<ImportHosts />);
    fireEvent.click(screen.getByText('Choose CSV file…'));
    await screen.findByText('already saved');

    const boxes = screen.getAllByRole('checkbox') as HTMLInputElement[];
    // [select all, core (saved), idf (new)]
    expect(boxes[1].disabled).toBe(true);
    expect(boxes[2].checked).toBe(true);

    fireEvent.click(screen.getByText(/^Import 1 host/));
    await waitFor(() => expect(useSessionStore.getState().showImportHosts).toBe(false));

    expect(invoke).toHaveBeenCalledWith('create_folder', { name: 'Branch' });
    const saves = vi.mocked(invoke).mock.calls.filter(([cmd]) => cmd === 'save_session');
    expect(saves).toHaveLength(1);
    expect(saves[0][1]).toMatchObject({ folderId: 'folder-new', config: { host: '10.0.0.2', username: 'admin' } });

    const branch = useSessionStore.getState().folders.find((f) => f.id === 'folder-new');
    expect(branch?.items.map((i) => i.host)).toEqual(['10.0.0.2']);
  });

  it('points to Settings when Aruba Central is not set up', async () => {
    vi.mocked(invoke).mockResolvedValue(false);
    useSessionStore.setState({ importHostsSource: 'central' });
    render(<ImportHosts />);
    fireEvent.click(await screen.findByText('Open Settings → Integrations'));
    const st = useSessionStore.getState();
    expect(st.showImportHosts).toBe(false);
    expect(st.showSettings).toBe(true);
    expect(st.settingsFocus).toBe('central');
  });
});
