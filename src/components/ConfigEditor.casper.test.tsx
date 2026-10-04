import { render, screen, fireEvent, waitFor, act, within } from '@testing-library/react';
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
/** A stand-in editor: its selection and its right-click actions, for the tests to drive. */
const fakeEditor = vi.hoisted(() => {
  const state = {
    selection: null as null | { startLineNumber: number; startColumn: number; endLineNumber: number; endColumn: number },
    actions: new Map<string, () => void>(),
  };
  const ed = {
    getModel: () => null,
    getSelection: () => state.selection,
    addAction: (a: { id: string; run: () => void }) => state.actions.set(a.id, a.run),
    onDidChangeCursorSelection: () => ({ dispose() {} }),
    onDidChangeModel: () => ({ dispose() {} }),
    pushUndoStop: () => {},
    executeEdits: () => {},
    focus: () => {},
    layout: () => {},
  };
  const monaco = {
    KeyMod: { CtrlCmd: 0, Shift: 0 },
    KeyCode: { KeyS: 0, KeyO: 0, KeyM: 0 },
    editor: { getModel: () => null, getModels: () => [] },
    Uri: { parse: (s: string) => s },
  };
  return { state, ed, monaco };
});

// A plain text box stands in for Monaco, so a test can edit the tab.
vi.mock('@monaco-editor/react', async () => {
  const { useEffect } = await import('react');
  function FakeMonaco(p: { value?: string; onChange?: (v: string) => void; onMount?: (ed: unknown, monaco: unknown) => void }) {
    // eslint-disable-next-line react-hooks/exhaustive-deps
    useEffect(() => p.onMount?.(fakeEditor.ed, fakeEditor.monaco), []);
    return <textarea aria-label="Editor text" value={p.value ?? ''} onChange={(e) => p.onChange?.(e.target.value)} />;
  }
  return { default: FakeMonaco, DiffEditor: () => null };
});
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

async function openTab(content = CONFIG) {
  const view = render(<ConfigEditor />);
  act(() => {
    useEditorInbox.getState().send({ name: 'core-sw1', content, language: 'aruba-cx' });
  });
  await screen.findByText('core-sw1');
  return view;
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
/** What the check cost, shown on its own so it is never cut off. */
const costLine = () => within(casperLine()).getByText(/^Casper used /);
const problemsText = () => {
  if (!screen.queryByRole('region', { name: 'Problems' })) fireEvent.click(screen.getByRole('button', { name: /^Problems: / }));
  return screen.getByRole('region', { name: 'Problems' }).textContent ?? '';
};
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
    fakeEditor.state.selection = null;
    fakeEditor.state.actions.clear();
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
    expect(casperLine().textContent).toContain('Casper marked 1 warning.');
    expect(costLine().textContent).toBe('Casper used 4,210 tokens (about $0.02).');
    expect(costLine().className).toMatch(/whitespace-nowrap/);
    expect(costLine().className).not.toMatch(/truncate/);
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
    expect(casperLine().textContent).toContain('Casper found no mistakes.');
    expect(costLine().textContent).toBe('Casper used 4,210 tokens (about $0.02).');
  });

  it('says so plainly when Casper is missing or answers without a list', async () => {
    await openTab();
    let run = await markWithCasper();
    await act(async () => {
      run.reject("Casper isn't installed, or GreenCLI can't find it. Install Casper, then try again.");
    });
    expect(casperLine().textContent).toContain("Casper isn't installed");
    // What to do is the end of the message: it wraps, never cut off.
    expect(within(casperLine()).getByText(/Casper isn't installed/).className).not.toMatch(/truncate/);

    run = await markWithCasper();
    await act(async () => {
      run.resolve('Everything looks fine! Run `write memory` now.' + USAGE);
    });
    expect(casperLine().textContent).toContain("Casper didn't send a list of mistakes. Ask again.");
    expect(costLine().textContent).toBe('Casper used 4,210 tokens (about $0.02).');
  });

  it('says what a run cost even when it ends without an answer', async () => {
    await openTab();
    const run = await markWithCasper();
    await act(async () => {
      run.reject('Casper stopped before it finished: Incomplete\n\nCasper used 9,000 tokens (about $0.12).');
    });
    expect(casperLine().textContent).toContain('Casper stopped before it finished: Incomplete');
    expect(costLine().textContent).toBe('Casper used 9,000 tokens (about $0.12).');
  });

  it("shows Casper's safety notes (a changed device, a secret in a command) in the editor", async () => {
    await openTab();
    const run = await markWithCasper();
    await act(async () => {
      run.resolve(
        reply(
          [{ line: 4, severity: 'warning', message: 'VLAN 30 is not in this tab.' }],
          '\n\n---\n*Casper changed things on sw1.*\n\n*A secret showed up in a command Casper ran. Change that secret.*' + USAGE.replace('\n\n---\n', '\n\n')
        )
      );
    });
    const status = casperLine().textContent ?? '';
    expect(status).toContain('Casper marked 1 warning.');
    expect(status).toContain('Casper changed things on sw1.');
    expect(status).toContain('A secret showed up in a command Casper ran. Change that secret.');
    expect(costLine().textContent).toBe('Casper used 4,210 tokens (about $0.02).');
  });

  it('puts a mark on the line it was about when the tab is edited while Casper checks', async () => {
    await openTab();
    const run = await markWithCasper();
    // Two lines pasted on top during the run: "    vlan access 30" moves from line 4 to 6.
    fireEvent.change(screen.getByLabelText('Editor text'), { target: { value: `interface 1/1/1\n    vlan access 30\n${CONFIG}` } });
    await act(async () => {
      run.resolve(
        reply([
          { line: 4, severity: 'warning', message: 'VLAN 30 is not in this tab.' },
          { line: 2, severity: 'tip', message: 'Name it after the floor.' },
        ])
      );
    });
    const panel = problemsText();
    expect(panel).toContain('Casper: VLAN 30 is not in this tab.');
    expect(screen.getByTitle('Go to line 6').textContent).toContain('VLAN 30 is not in this tab.');
    expect(screen.queryByTitle('Go to line 4')?.textContent ?? '').not.toContain('VLAN 30');
    expect(panel).toContain('Name it after the floor.');
    expect(screen.getByTitle('Go to line 4').textContent).toContain('Name it after the floor.');
  });

  it('leaves out marks whose lines were changed while Casper checked, and says so', async () => {
    await openTab();
    const run = await markWithCasper();
    fireEvent.change(screen.getByLabelText('Editor text'), { target: { value: CONFIG.replace('vlan access 30', 'vlan access 10') } });
    await act(async () => {
      run.resolve(reply([{ line: 4, severity: 'warning', message: 'VLAN 30 is not in this tab.' }]));
    });
    expect(casperLine().textContent).toContain('1 finding left out: its line changed while Casper checked. Ask again.');
    expect(problemsText()).not.toContain('VLAN 30 is not in this tab.');
  });

  it('offers "Fix the problems found" only for problems GreenCLI found, not for Casper\'s marks', async () => {
    await openTab();
    const before = askMenuItems().map((b) => b.textContent ?? '');
    fireEvent.keyDown(document, { key: 'Escape' });
    const run = await markWithCasper();
    await act(async () => {
      run.resolve(reply([{ line: 1, severity: 'error', message: 'Casper thinks this is wrong.' }]));
    });
    expect(casperLine().textContent).toContain('Casper marked 1 error.');
    const after = askMenuItems().map((b) => b.textContent ?? '');
    expect(after.some((l) => l.startsWith('Fix the problems found'))).toBe(before.some((l) => l.startsWith('Fix the problems found')));
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

  it('closing the tab mid-run cancels it, and the late answer is ignored', async () => {
    await openTab();
    const run = await markWithCasper();
    askConfirm.mockResolvedValueOnce(true);
    const tab = screen.getByText('core-sw1').parentElement as HTMLElement;
    fireEvent.click(within(tab).getByRole('button', { name: 'Close tab' }));
    await waitFor(() => expect(cancels()).toEqual([run.args.runId]));
    await act(async () => {
      run.resolve(reply([{ line: 1, severity: 'error', message: 'Too late.' }]));
    });
    expect(screen.queryByRole('status', { name: 'Casper' })).toBeNull();
    expect(screen.queryByText(/Too late/)).toBeNull();
  });

  it('closing the editor mid-run cancels it', async () => {
    const view = await openTab();
    const run = await markWithCasper();
    view.unmount();
    expect(cancels()).toEqual([run.args.runId]);
  });

  it('sends nothing when hiding the secrets would move lines', async () => {
    vi.mocked(hideSecretsInText).mockResolvedValueOnce({ ok: true, text: CONFIG + '\nextra', hidden: 1, words: [] });
    await openTab();
    fireEvent.click(askMenuItems().find((b) => b.textContent?.startsWith('Mark mistakes with Casper')) as HTMLElement);
    await screen.findByText('Not sent to Casper: hiding the secrets moved lines');
    expect(mockInvoke.mock.calls.some(([cmd]) => cmd === 'ai_cli')).toBe(false);
  });

  it('refuses a tab too big for Casper', async () => {
    await openTab('vlan 10\n'.repeat(10_000));
    fireEvent.click(askMenuItems().find((b) => b.textContent?.startsWith('Mark mistakes with Casper')) as HTMLElement);
    await screen.findByText('Too big for Casper: select fewer lines');
    expect(mockInvoke.mock.calls.some(([cmd]) => cmd === 'ai_cli')).toBe(false);
  });

  it('sends only the selected lines, numbered as in the tab', async () => {
    await openTab();
    fakeEditor.state.selection = { startLineNumber: 3, startColumn: 1, endLineNumber: 4, endColumn: 5 };
    const run = await markWithCasper();
    const prompt = String(run.args.prompt);
    expect(prompt).toContain('3| interface 1/1/5');
    expect(prompt).toContain('4|     vlan access 30');
    expect(prompt).not.toContain('name users');
    expect(prompt).not.toContain('<secret hidden>');
  });

  it('runs from the right-click menu', async () => {
    await openTab();
    act(() => fakeEditor.state.actions.get('greencli-ask-casper')?.());
    await waitFor(() => expect(runs.length).toBe(1));
    expect(String(runs[0].args.prompt)).toContain('4|     vlan access 30');
  });
});
