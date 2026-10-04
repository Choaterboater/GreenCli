import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';
import { describe, it, expect, vi, beforeAll, beforeEach } from 'vitest';
import { invoke } from '@tauri-apps/api/core';
import ConfigEditor from './ConfigEditor';
import { useSessionStore } from '../store/sessionStore';
import { useSettingsStore } from '../store/settingsStore';
import { useEditorInbox } from '../store/editorInboxStore';
import { hideSecretsInText } from '../utils/secrets/forCopy';
import { cancelActiveAiStreams } from '../utils/aiRuns';

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }));
vi.mock('@tauri-apps/api/event', () => ({ listen: vi.fn().mockResolvedValue(() => undefined) }));
vi.mock('@monaco-editor/react', () => ({ default: () => null, DiffEditor: () => null }));
vi.mock('../editor/setup', () => ({ setupMonaco: vi.fn() }));
// jsdom can't run the secret filter; the real one is tested on its own.
vi.mock('../utils/secrets/forCopy', () => ({
  hideSecretsInText: vi.fn(async (text: string) => ({
    ok: true,
    text: text.replace(/(key plaintext )\S+/g, '$1<secret hidden>'),
    hidden: /key plaintext/.test(text) ? 1 : 0,
    words: [],
  })),
  hideSecretsForCopy: vi.fn(),
}));

const askConfirm = vi.hoisted(() => vi.fn());
vi.mock('../store/dialogStore', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../store/dialogStore')>()),
  askConfirm,
}));

const mockInvoke = vi.mocked(invoke);
const CONFIG = 'vlan 10\n  name users\ninterface 1/1/5\n    vlan access 30\n    radius-server key plaintext Hunter2\n';
const USAGE = '\n\n---\n*Casper used 4,210 tokens (about $0.02).*';
const reply = (problems: unknown[], tail = USAGE) => `Done.\n\n\`\`\`json\n${JSON.stringify({ problems })}\n\`\`\`${tail}`;

/** Each ai_cli call waits until the test answers it. */
let runs: Array<{ args: Record<string, unknown>; resolve: (v: string) => void; reject: (e: unknown) => void }> = [];

async function openTab() {
  render(<ConfigEditor />);
  act(() => {
    useEditorInbox.getState().send({ name: 'core-sw1', content: CONFIG, language: 'aruba-cx' });
  });
  await screen.findByText('core-sw1');
}

function askMenuItems() {
  fireEvent.click(screen.getByTitle('Ask the AI about this tab'));
  return screen.getAllByRole('menuitem');
}

async function markWithCasper() {
  fireEvent.click(askMenuItems().find((b) => b.textContent?.startsWith('Mark mistakes with Casper')) as HTMLElement);
  await waitFor(() => expect(runs.length).toBeGreaterThan(0));
  return runs[runs.length - 1];
}

const casperLine = () => screen.getByRole('status', { name: 'Casper' });
const cancels = () => mockInvoke.mock.calls.filter(([cmd]) => cmd === 'ai_cancel_stream').map(([, a]) => (a as { streamId: string }).streamId);

describe('ConfigEditor: Mark mistakes with Casper', () => {
  beforeAll(() => {
    Element.prototype.scrollIntoView ??= vi.fn();
  });

  beforeEach(() => {
    runs = [];
    mockInvoke.mockReset();
    mockInvoke.mockImplementation((cmd: string, args?: unknown) => {
      if (cmd === 'ai_cli') {
        return new Promise((resolve, reject) => runs.push({ args: args as Record<string, unknown>, resolve, reject }));
      }
      return Promise.resolve('');
    });
    vi.mocked(hideSecretsInText).mockClear();
    useSessionStore.setState({ showConfigEditor: true, sessions: [], activeSessionId: null });
    useSettingsStore.setState({ casperCommand: '', sessionLogDir: '' });
    useEditorInbox.setState({ pending: [] });
  });

  it('sits next to "Check them for mistakes" and says what it does', async () => {
    await openTab();
    const labels = askMenuItems().map((b) => b.textContent ?? '');
    const check = labels.findIndex((l) => l.startsWith('Check them for mistakes'));
    expect(labels[check + 1]).toMatch(/^Mark mistakes with Casper.*secrets hidden.*may cost tokens/);
  });

  it('sends the tab to Casper with secrets hidden, then marks what it finds', async () => {
    await openTab();
    const run = await markWithCasper();
    expect(run.args).toMatchObject({ command: 'casper', workFolder: null, asCasper: true, logFolder: null });
    const prompt = String(run.args.prompt);
    expect(prompt).toContain('4|     vlan access 30');
    expect(prompt).toContain('<secret hidden>');
    expect(prompt).not.toContain('Hunter2');
    expect(casperLine().textContent).toContain('Casper is checking');
    expect(screen.getByRole('button', { name: 'Stop Casper' })).toBeTruthy();

    await act(async () => {
      run.resolve(reply([{ line: 4, severity: 'warning', message: 'VLAN 30 is not in this tab.' }, { line: 40, severity: 'error', message: 'No such line.' }]));
    });
    expect(casperLine().textContent).toContain('Casper marked 1 warning. Casper used 4,210 tokens (about $0.02).');
    expect(screen.queryByRole('button', { name: 'Stop Casper' })).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: /^Problems: / }));
    const panel = screen.getByRole('region', { name: 'Problems' });
    expect(panel.textContent).toContain('Casper: VLAN 30 is not in this tab.');
    expect(panel.textContent).not.toContain('No such line.');

    // Clear takes Casper's marks away.
    fireEvent.click(screen.getByRole('button', { name: "Clear Casper's marks" }));
    expect(screen.queryByRole('status', { name: 'Casper' })).toBeNull();
    expect(screen.getByRole('region', { name: 'Problems' }).textContent).not.toContain('Casper:');
  });

  it('Stop cancels the run and a late answer is ignored', async () => {
    await openTab();
    const run = await markWithCasper();
    fireEvent.click(screen.getByRole('button', { name: 'Stop Casper' }));
    expect(cancels()).toEqual([run.args.runId]);
    expect(casperLine().textContent).toContain('Stopped.');
    await act(async () => {
      run.resolve(reply([{ line: 1, severity: 'error', message: 'Too late.' }]));
    });
    expect(casperLine().textContent).toContain('Stopped.');
    expect(screen.queryByText(/Too late/)).toBeNull();
  });

  it("the AI panel's Stop reaches a check too", async () => {
    await openTab();
    const run = await markWithCasper();
    cancelActiveAiStreams();
    expect(cancels()).toContain(run.args.runId);
    await act(async () => {
      run.reject('Stopped.');
    });
    expect(casperLine().textContent).toContain('Stopped.');
  });

  it("a new run cancels the old one, whose answer never lands", async () => {
    await openTab();
    const first = await markWithCasper();
    const second = await markWithCasper();
    expect(second.args.runId).not.toBe(first.args.runId);
    expect(cancels()).toEqual([first.args.runId]);
    await act(async () => {
      first.resolve(reply([{ line: 1, severity: 'error', message: 'Old answer.' }]));
    });
    expect(casperLine().textContent).toContain('Casper is checking');
    await act(async () => {
      second.resolve(reply([]));
    });
    expect(casperLine().textContent).toContain('Casper found no mistakes. Casper used 4,210 tokens (about $0.02).');
  });

  it('says so plainly when Casper is missing or answers without a list', async () => {
    await openTab();
    let run = await markWithCasper();
    await act(async () => {
      run.reject("Casper isn't installed, or GreenCLI can't find it. Install Casper, then try again.");
    });
    expect(casperLine().textContent).toContain("Casper isn't installed");

    run = await markWithCasper();
    await act(async () => {
      run.resolve('Everything looks fine! Run `write memory` now.' + USAGE);
    });
    expect(casperLine().textContent).toContain("Casper didn't send a list of mistakes. Ask again. Casper used 4,210 tokens (about $0.02).");
  });

  it("never puts Casper's findings in the Send confirmation", async () => {
    useSessionStore.setState({
      sessions: [{ sessionId: 's1', connected: true, config: { id: 'sw1', name: 'sw1', protocol: 'ssh', host: '10.0.0.1', deviceType: 'aruba-cx' } }],
      activeSessionId: 's1',
    });
    askConfirm.mockReset().mockResolvedValue(false);
    await openTab();
    const run = await markWithCasper();
    await act(async () => {
      run.resolve(reply([{ line: 1, severity: 'error', message: 'Casper thinks this is wrong.' }]));
    });
    expect(casperLine().textContent).toContain('Casper marked 1 error.');
    fireEvent.click(screen.getByTitle('Send lines to terminal'));
    await waitFor(() => expect(askConfirm).toHaveBeenCalled());
    expect(JSON.stringify(askConfirm.mock.calls[0])).not.toContain('Casper thinks this is wrong.');
  });

  it('sends nothing when the secrets check cannot run', async () => {
    vi.mocked(hideSecretsInText).mockResolvedValueOnce({ ok: false, reason: 'unsupported' });
    await openTab();
    fireEvent.click(askMenuItems().find((b) => b.textContent?.startsWith('Mark mistakes with Casper')) as HTMLElement);
    await screen.findByText(/Not sent to Casper/);
    expect(mockInvoke.mock.calls.some(([cmd]) => cmd === 'ai_cli')).toBe(false);
  });
});
