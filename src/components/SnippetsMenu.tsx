import { useState } from 'react';
import { Zap, ChevronDown, Plus, X, Send } from 'lucide-react';
import { invoke } from '@tauri-apps/api/tauri';
import { useSnippetsStore } from '../store/snippetsStore';
import { useSessionStore } from '../store/sessionStore';

// Title-bar dropdown of saved command snippets. Clicking one sends it to the
// active terminal session; new ones can be added inline.
export default function SnippetsMenu() {
  const { snippets, addSnippet, removeSnippet } = useSnippetsStore();
  const { sessions, activeSessionId } = useSessionStore();
  const activeSession = sessions.find((s) => s.sessionId === activeSessionId);

  const [open, setOpen] = useState(false);
  const [adding, setAdding] = useState(false);
  const [label, setLabel] = useState('');
  const [command, setCommand] = useState('');

  const send = (cmd: string) => {
    if (!activeSession?.connected) return;
    invoke('send_data', { sessionId: activeSession.sessionId, data: cmd + '\r' }).catch(() => {});
    setOpen(false);
  };

  const saveNew = () => {
    if (!label.trim() || !command.trim()) return;
    addSnippet(label.trim(), command.trim());
    setLabel('');
    setCommand('');
    setAdding(false);
  };

  return (
    <div className="relative">
      <button
        onClick={() => setOpen(!open)}
        className={`flex items-center gap-1.5 px-2 py-1 text-xs rounded transition-colors ${
          open ? 'text-[#e5c07b] bg-[#e5c07b20]' : 'text-[#8b949e] hover:text-[#c9d1d9] hover:bg-[#21262d]'
        }`}
        title="Command snippets"
      >
        <Zap size={12} />
        <span>Snippets</span>
        <ChevronDown size={10} />
      </button>

      {open && (
        <>
          <div className="fixed inset-0 z-20" onClick={() => setOpen(false)} />
          <div className="absolute top-full right-0 mt-1 z-30 w-72 bg-[#161b22] border border-[#30363d] rounded-lg shadow-xl flex flex-col">
            <div className="px-3 py-2 border-b border-[#21262d] flex items-center justify-between">
              <span className="text-[10px] font-semibold text-[#8b949e] uppercase tracking-wider">
                Snippets
              </span>
              {!activeSession?.connected && (
                <span className="text-[9px] text-[#484f58]">no active session</span>
              )}
            </div>

            <div className="max-h-72 overflow-y-auto py-1">
              {snippets.length === 0 && (
                <p className="px-3 py-2 text-xs text-[#484f58]">No snippets yet.</p>
              )}
              {snippets.map((s) => (
                <div key={s.id} className="group flex items-center gap-1 px-2 hover:bg-[#21262d]">
                  <button
                    onClick={() => send(s.command)}
                    disabled={!activeSession?.connected}
                    className="flex-1 flex items-center gap-2 px-1 py-1.5 text-left disabled:opacity-40"
                    title={activeSession?.connected ? `Send: ${s.command}` : 'Connect a session first'}
                  >
                    <Send size={10} className="text-[#3fb950] flex-shrink-0" />
                    <span className="text-xs text-[#c9d1d9] truncate flex-shrink-0 max-w-[90px]">{s.label}</span>
                    <code className="text-[10px] text-[#484f58] font-mono truncate">{s.command}</code>
                  </button>
                  <button
                    onClick={() => removeSnippet(s.id)}
                    className="opacity-0 group-hover:opacity-100 p-1 rounded hover:bg-[#30363d] text-[#8b949e] hover:text-[#ff7b72] flex-shrink-0"
                    title="Delete snippet"
                  >
                    <X size={11} />
                  </button>
                </div>
              ))}
            </div>

            <div className="border-t border-[#21262d] p-2">
              {adding ? (
                <div className="space-y-1.5">
                  <input
                    autoFocus
                    value={label}
                    onChange={(e) => setLabel(e.target.value)}
                    placeholder="Label (e.g. PoE status)"
                    className="w-full text-xs bg-[#0d1117] border border-[#30363d] rounded px-2 py-1 text-[#c9d1d9] placeholder-[#484f58] focus:outline-none focus:border-[#58a6ff]"
                  />
                  <input
                    value={command}
                    onChange={(e) => setCommand(e.target.value)}
                    onKeyDown={(e) => e.key === 'Enter' && saveNew()}
                    placeholder="Command (e.g. show power-over-ethernet)"
                    className="w-full text-xs bg-[#0d1117] border border-[#30363d] rounded px-2 py-1 text-[#c9d1d9] placeholder-[#484f58] focus:outline-none focus:border-[#58a6ff] font-mono"
                  />
                  <div className="flex gap-1.5">
                    <button onClick={saveNew} className="flex-1 px-2 py-1 text-xs bg-[#238636] hover:bg-[#2ea043] text-white rounded">Save</button>
                    <button onClick={() => setAdding(false)} className="px-2 py-1 text-xs bg-[#21262d] hover:bg-[#30363d] text-[#8b949e] rounded">Cancel</button>
                  </div>
                </div>
              ) : (
                <button
                  onClick={() => setAdding(true)}
                  className="flex items-center gap-1.5 w-full px-2 py-1 text-xs text-[#8b949e] hover:text-[#c9d1d9] hover:bg-[#21262d] rounded transition-colors"
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
