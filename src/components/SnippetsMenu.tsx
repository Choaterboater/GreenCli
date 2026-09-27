import { useState } from 'react';
import { Zap, Plus, X, Send } from 'lucide-react';
import { invoke } from '@tauri-apps/api/tauri';
import { useSnippetsStore, Snippet } from '../store/snippetsStore';
import { useSessionStore } from '../store/sessionStore';
import { useSettingsStore } from '../store/settingsStore';
import { askConfirm, askPrompt } from '../store/dialogStore';
import { countPasteLines } from '../store/terminalToolsStore';
import { notify } from '../store/toastStore';
import { getTerminalActionAdapter } from '../utils/terminalActions';
import { fillPlaceholders, snippetPlaceholders } from '../utils/snippetTemplate';

const isMac = navigator.platform.toUpperCase().includes('MAC');

// Tab-strip dropdown of saved command snippets. Clicking one types it into the
// active terminal WITHOUT Enter, so it can be checked or edited first;
// Shift+click runs it. New ones can be added inline.
export default function SnippetsMenu() {
  const { snippets, addSnippet, removeSnippet } = useSnippetsStore();
  const { sessions, activeSessionId } = useSessionStore();
  const activeSession = sessions.find((s) => s.sessionId === activeSessionId);

  const [open, setOpen] = useState(false);
  const [adding, setAdding] = useState(false);
  const [label, setLabel] = useState('');
  const [command, setCommand] = useState('');

  const applySnippet = async (snippet: Snippet, run: boolean) => {
    if (!activeSession?.connected) return;
    const sid = activeSession.sessionId;
    const target = activeSession.config.name || activeSession.config.host || 'the terminal';
    setOpen(false);

    // Ask for each {{name}} once, in order; Cancel on any of them aborts.
    let text = snippet.command.replace(/\r\n?/g, '\n');
    const names = snippetPlaceholders(text);
    const values: Record<string, string> = {};
    for (const [i, name] of names.entries()) {
      const value = await askPrompt({
        title: `Value for {{${name}}}`,
        message: `Snippet "${snippet.label}"${names.length > 1 ? ` (${i + 1} of ${names.length})` : ''}`,
        placeholder: name,
        confirmLabel: i < names.length - 1 ? 'Next' : run ? 'Run' : 'Insert',
      });
      if (value === null) return;
      values[name] = value;
    }
    text = fillPlaceholders(text, values);

    // Same multi-line guard as a clipboard paste: each line but the last runs
    // on the device the moment it lands.
    const lineCount = countPasteLines(text);
    const { pasteGuardEnabled, pasteGuardLineThreshold } = useSettingsStore.getState();
    if (text.includes('\n') && pasteGuardEnabled && lineCount >= pasteGuardLineThreshold) {
      const ok = await askConfirm({
        title: `${run ? 'Run' : 'Paste'} ${lineCount} lines into ${target}?`,
        message: run
          ? 'Every line runs as a command on the connected device.'
          : 'Every line except the last runs as a command on the connected device as soon as it is pasted.',
        confirmLabel: run ? 'Run' : 'Paste',
      });
      if (!ok) return;
    }

    // The session may have dropped while a dialog was open.
    if (!useSessionStore.getState().sessions.find((s) => s.sessionId === sid)?.connected) {
      notify.warning('Snippet not sent', `${target} is no longer connected.`);
      return;
    }
    const adapter = getTerminalActionAdapter(sid);
    const fail = () => notify.error('Snippet failed', 'Could not send to the active session.');
    if (run && !text.includes('\n')) {
      // Single line: send directly (a bracketed paste wouldn't execute in a local shell).
      invoke('send_data', { sessionId: sid, data: text + '\r' }).catch(fail);
      adapter?.focus();
    } else if (adapter) {
      // The terminal's paste path: LF→CR, bracketed paste where the far end asked for it.
      adapter.paste(run ? text + '\r' : text);
    } else {
      invoke('send_data', { sessionId: sid, data: text.replace(/\n/g, '\r') + (run ? '\r' : '') }).catch(fail);
    }
  };

  const deleteSnippet = async (snippet: Snippet) => {
    const ok = await askConfirm({
      title: `Delete snippet "${snippet.label}"?`,
      message: snippet.command.split('\n')[0],
      confirmLabel: 'Delete',
      danger: true,
    });
    if (ok) removeSnippet(snippet.id);
  };

  const saveNew = () => {
    // Keep inner newlines — multi-line snippets are one command per line.
    const cmd = command.replace(/\r\n?/g, '\n').trim();
    if (!label.trim() || !cmd) return;
    addSnippet(label.trim(), cmd);
    setLabel('');
    setCommand('');
    setAdding(false);
  };

  const connected = !!activeSession?.connected;

  return (
    <div className="relative">
      <button
        onClick={() => setOpen(!open)}
        className={`flex items-center justify-center w-7 h-7 rounded-md transition-colors ${
          open
            ? 'text-[var(--accent-warning)] bg-[var(--accent-2-soft)]'
            : 'text-[var(--text-secondary)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-tertiary)]'
        }`}
        title="Snippets: saved commands to type into the active session"
        aria-label="Snippets"
        aria-haspopup="menu"
        aria-expanded={open}
      >
        <Zap size={15} />
      </button>

      {open && (
        <>
          <div className="fixed inset-0 z-20" onClick={() => setOpen(false)} />
          <div className="absolute top-full right-0 mt-1 z-30 w-72 bg-[var(--bg-secondary)] border border-[var(--border)] rounded-lg shadow-xl flex flex-col">
            <div className="px-3 py-2 border-b border-[var(--bg-tertiary)]">
              <div className="flex items-center justify-between">
                <span className="text-[10px] font-semibold text-[var(--text-secondary)] uppercase tracking-wider">
                  Snippets
                </span>
                {!connected && <span className="text-[9px] text-[var(--text-muted)]">no active session</span>}
              </div>
              <p className="mt-0.5 text-[10px] text-[var(--text-muted)]">Click to insert · Shift+click to run</p>
            </div>

            <div className="max-h-72 overflow-y-auto py-1">
              {snippets.length === 0 && (
                <p className="px-3 py-2 text-xs text-[var(--text-muted)]">No snippets yet.</p>
              )}
              {snippets.map((s) => {
                const [first, ...rest] = s.command.split('\n');
                return (
                  <div key={s.id} className="group flex items-center gap-1 px-2 hover:bg-[var(--bg-tertiary)]">
                    <button
                      onClick={(e) => void applySnippet(s, e.shiftKey)}
                      disabled={!connected}
                      className="flex-1 min-w-0 flex items-center gap-2 px-1 py-1.5 text-left disabled:opacity-40"
                      title={connected ? `${s.command}\n\nClick to insert · Shift+click to run` : 'Connect a session first'}
                    >
                      <Send size={10} className="text-[#3fb950] flex-shrink-0" />
                      <span className="text-xs text-[var(--text-primary)] truncate flex-shrink-0 max-w-[90px]">{s.label}</span>
                      <code className="text-[10px] text-[var(--text-muted)] font-mono truncate">{first}</code>
                      {rest.length > 0 && (
                        <span className="text-[9px] text-[var(--text-muted)] flex-shrink-0">+{rest.length} lines</span>
                      )}
                    </button>
                    <button
                      onClick={() => void deleteSnippet(s)}
                      className="opacity-0 group-hover:opacity-100 p-1 rounded hover:bg-[var(--border)] text-[var(--text-secondary)] hover:text-[#ff7b72] flex-shrink-0"
                      title="Delete snippet"
                    >
                      <X size={11} />
                    </button>
                  </div>
                );
              })}
            </div>

            <div className="border-t border-[var(--bg-tertiary)] p-2">
              {adding ? (
                <div className="space-y-1.5">
                  <input
                    autoFocus
                    value={label}
                    onChange={(e) => setLabel(e.target.value)}
                    onKeyDown={(e) => e.key === 'Enter' && saveNew()}
                    placeholder="Label (e.g. PoE status)"
                    className="w-full text-xs bg-[var(--bg-primary)] border border-[var(--border)] rounded px-2 py-1 text-[var(--text-primary)] placeholder-[var(--text-muted)] focus:outline-none focus:border-[#58a6ff]"
                  />
                  <textarea
                    value={command}
                    onChange={(e) => setCommand(e.target.value)}
                    onKeyDown={(e) => {
                      // Enter adds a line (multi-line snippets); Ctrl/Cmd+Enter saves.
                      if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
                        e.preventDefault();
                        saveNew();
                      }
                    }}
                    rows={2}
                    spellCheck={false}
                    placeholder={'Command (e.g. show interface {{port}})'}
                    className="w-full text-xs bg-[var(--bg-primary)] border border-[var(--border)] rounded px-2 py-1 text-[var(--text-primary)] placeholder-[var(--text-muted)] focus:outline-none focus:border-[#58a6ff] font-mono resize-y"
                  />
                  <p className="text-[10px] text-[var(--text-muted)] leading-snug">
                    One command per line. {'{{name}}'} asks for a value each time. {isMac ? '⌘' : 'Ctrl'}+Enter saves.
                  </p>
                  <div className="flex gap-1.5">
                    <button onClick={saveNew} className="flex-1 px-2 py-1 text-xs bg-[#238636] hover:bg-[#2ea043] text-white rounded">Save</button>
                    <button onClick={() => setAdding(false)} className="px-2 py-1 text-xs bg-[var(--bg-tertiary)] hover:bg-[var(--border)] text-[var(--text-secondary)] rounded">Cancel</button>
                  </div>
                </div>
              ) : (
                <button
                  onClick={() => setAdding(true)}
                  className="flex items-center gap-1.5 w-full px-2 py-1 text-xs text-[var(--text-secondary)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-tertiary)] rounded transition-colors"
                >
                  <Plus size={12} />
                  New snippet
                </button>
              )}
            </div>
          </div>
        </>
      )}
    </div>
  );
}
