import { useCallback, useEffect, useState } from 'react';
import { invoke } from '@tauri-apps/api/tauri';
import {
  Plus,
  Trash2,
  Loader2,
  Plug,
  Power,
  PencilLine,
  Server,
  CheckCircle2,
} from 'lucide-react';
import { notify } from '../store/toastStore';
import { askConfirm } from '../store/dialogStore';

interface McpServerDef {
  name: string;
  command: string;
  args: string[];
  env: Record<string, string>;
  cwd?: string;
  credentialsEnvVar?: string;
  enabled: boolean;
}

interface McpStatus {
  name: string;
  enabled: boolean;
  connected: boolean;
  toolCount: number;
}

const blankForm = {
  name: '',
  command: '',
  argsText: '',
  envText: '',
  cwd: '',
  credsEnvVar: '',
  credsContent: '',
};

export default function McpServers() {
  const [servers, setServers] = useState<McpServerDef[]>([]);
  const [status, setStatus] = useState<Record<string, McpStatus>>({});
  const [busy, setBusy] = useState<string | null>(null);
  const [showForm, setShowForm] = useState(false);
  const [form, setForm] = useState({ ...blankForm });
  const [credsSaved, setCredsSaved] = useState(false);
  // The name the form was opened on, so a rename can move the server instead of
  // leaving the old name behind as a duplicate.
  const [editingName, setEditingName] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const defs = (await invoke<McpServerDef[]>('mcp_list_servers')) || [];
      setServers(defs);
      const st = (await invoke<McpStatus[]>('mcp_status')) || [];
      const map: Record<string, McpStatus> = {};
      st.forEach((s) => (map[s.name] = s));
      setStatus(map);
    } catch {
      /* not running under Tauri */
    }
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const connect = async (name: string) => {
    setBusy(name);
    try {
      const n = await invoke<number>('mcp_connect', { name });
      notify.success(`${name} connected`, `${n} tool${n === 1 ? '' : 's'} now available to the AI`);
    } catch (e) {
      notify.error(`${name} failed to connect`, String(e));
    } finally {
      setBusy(null);
      refresh();
    }
  };

  const disconnect = async (name: string) => {
    await invoke('mcp_disconnect', { name }).catch(() => {});
    refresh();
  };

  const remove = async (name: string) => {
    const ok = await askConfirm({
      title: `Remove "${name}"?`,
      message: 'This deletes the server definition (command, args, env, credentials mapping). This cannot be undone.',
      confirmLabel: 'Remove',
      danger: true,
    });
    if (!ok) return;
    await invoke('mcp_delete_server', { name }).catch(() => {});
    notify.info('MCP server removed', name);
    refresh();
  };

  const edit = (s: McpServerDef) => {
    setEditingName(s.name);
    setForm({
      name: s.name,
      command: s.command,
      argsText: (s.args || []).join('\n'),
      envText: Object.entries(s.env || {})
        .map(([k, v]) => `${k}=${v}`)
        .join('\n'),
      cwd: s.cwd || '',
      credsEnvVar: s.credentialsEnvVar || '',
      credsContent: '',
    });
    invoke<boolean>('mcp_has_credentials', { name: s.name })
      .then(setCredsSaved)
      .catch(() => setCredsSaved(false));
    setShowForm(true);
  };

  const save = async () => {
    if (!form.name.trim() || !form.command.trim()) {
      notify.warning('Name and command are required');
      return;
    }
    const args = form.argsText.split('\n').map((s) => s.trim()).filter(Boolean);
    const env: Record<string, string> = {};
    form.envText.split('\n').forEach((line) => {
      const i = line.indexOf('=');
      if (i > 0) env[line.slice(0, i).trim()] = line.slice(i + 1).trim();
    });
    const def: McpServerDef = {
      name: form.name.trim(),
      command: form.command.trim(),
      args,
      env,
      cwd: form.cwd.trim() || undefined,
      credentialsEnvVar: form.credsEnvVar.trim() || undefined,
      enabled: true,
    };
    try {
      await invoke('mcp_save_server', { def });
      // A rename writes under the new name; remove the old entry so we don't leave
      // an orphaned duplicate behind.
      if (editingName && editingName !== def.name) {
        await invoke('mcp_delete_server', { name: editingName }).catch(() => {});
      }
      // Persist credentials content only when the user typed new content (so we
      // never wipe saved creds just because the field is blank on edit).
      if (form.credsContent.trim()) {
        await invoke('mcp_set_credentials', { name: def.name, content: form.credsContent });
      }
      notify.success('MCP server saved', def.name);
      setShowForm(false);
      setForm({ ...blankForm });
      setCredsSaved(false);
      setEditingName(null);
      refresh();
    } catch (e) {
      notify.error('Could not save MCP server', String(e));
    }
  };

  const input = 'input-field w-full h-8 px-2 text-sm';

  return (
    <section>
      <div className="flex items-center justify-between mb-3">
        <h3 className="text-sm font-semibold text-[var(--text-primary)]">MCP Servers</h3>
        <button
          onClick={() => {
            setForm({ ...blankForm });
            setCredsSaved(false);
            setEditingName(null);
            setShowForm((v) => !v);
          }}
          className="flex items-center gap-1.5 px-2.5 py-1 text-[11px] rounded-md bg-[var(--bg-tertiary)] hover:bg-[var(--border-strong)] text-[var(--text-primary)] transition-colors"
        >
          <Plus size={13} />
          Add server
        </button>
      </div>

      <p className="text-[11px] text-[var(--text-secondary)] mb-3 leading-relaxed">
        Connect external <span className="text-[var(--text-primary)]">MCP servers</span> (stdio) to give the
        AI assistant real tools — your <code className="text-[var(--accent)]">centralmcp</code> Aruba Central/GLP
        server, a future Juniper/Mist one, etc. Tools are offered to <em>every</em> AI provider, not just one.
      </p>

      {/* Server list */}
      <div className="space-y-2">
        {servers.length === 0 && !showForm && (
          <div className="px-3 py-4 rounded-[var(--radius)] border border-dashed border-[var(--border)] text-center text-[11px] text-[var(--text-muted)]">
            No MCP servers yet. Click <strong>Add server</strong> to connect one.
          </div>
        )}
        {servers.map((s) => {
          const st = status[s.name];
          const connected = st?.connected;
          return (
            <div
              key={s.name}
              className="flex items-center gap-2 px-3 py-2 rounded-[var(--radius)] border border-[var(--border)] bg-[var(--bg-inset)]"
            >
              <Server size={15} className="flex-shrink-0" style={{ color: connected ? 'var(--accent)' : 'var(--text-muted)' }} />
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <span className="text-[13px] font-medium text-[var(--text-primary)] truncate">{s.name}</span>
                  {connected && (
                    <span className="flex items-center gap-1 text-[10px] text-[var(--accent-success)]">
                      <CheckCircle2 size={10} />
                      {st?.toolCount ?? 0} tools
                    </span>
                  )}
                </div>
                <div className="text-[10px] text-[var(--text-muted)] font-mono truncate">
                  {s.command} {(s.args || []).join(' ')}
                </div>
              </div>
              {connected ? (
                <button
                  onClick={() => disconnect(s.name)}
                  className="flex items-center gap-1 px-2 py-1 text-[11px] rounded-md text-[var(--accent-warning)] hover:bg-[var(--bg-tertiary)]"
                  title="Disconnect"
                >
                  <Power size={12} />
                </button>
              ) : (
                <button
                  onClick={() => connect(s.name)}
                  disabled={busy === s.name}
                  className="flex items-center gap-1 px-2 py-1 text-[11px] rounded-md text-[var(--accent)] hover:bg-[var(--bg-tertiary)] disabled:opacity-50"
                  title="Connect"
                >
                  {busy === s.name ? <Loader2 size={12} className="animate-spin" /> : <Plug size={12} />}
                </button>
              )}
              <button
                onClick={() => edit(s)}
                className="p-1 rounded-md text-[var(--text-muted)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-tertiary)]"
                title="Edit"
              >
                <PencilLine size={12} />
              </button>
              <button
                onClick={() => remove(s.name)}
                className="p-1 rounded-md text-[var(--text-muted)] hover:text-[var(--accent-danger)] hover:bg-[var(--bg-tertiary)]"
                title="Remove"
              >
                <Trash2 size={12} />
              </button>
            </div>
          );
        })}
      </div>

      {/* Add / edit form */}
      {showForm && (
        <div className="mt-3 p-3 rounded-[var(--radius)] border border-[var(--border-strong)] bg-[var(--bg-secondary)] space-y-2.5">
          <div className="grid grid-cols-2 gap-2">
            <div>
              <label className="block text-[10px] uppercase tracking-wide text-[var(--text-secondary)] mb-1">Name</label>
              <input className={input} value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="centralmcp" />
            </div>
            <div>
              <label className="block text-[10px] uppercase tracking-wide text-[var(--text-secondary)] mb-1">Command</label>
              <input className={`${input} font-mono`} value={form.command} onChange={(e) => setForm({ ...form, command: e.target.value })} placeholder="uv" />
            </div>
          </div>
          <div>
            <label className="block text-[10px] uppercase tracking-wide text-[var(--text-secondary)] mb-1">Args (one per line)</label>
            <textarea
              className="input-field w-full px-2 py-1.5 text-xs font-mono resize-y"
              rows={3}
              value={form.argsText}
              onChange={(e) => setForm({ ...form, argsText: e.target.value })}
              placeholder={'run\n--directory\n/path/to/centralmcp\naruba-tool-router'}
            />
          </div>
          <div className="grid grid-cols-2 gap-2">
            <div>
              <label className="block text-[10px] uppercase tracking-wide text-[var(--text-secondary)] mb-1">Working dir (optional)</label>
              <input className={`${input} font-mono`} value={form.cwd} onChange={(e) => setForm({ ...form, cwd: e.target.value })} placeholder="/path/to/centralmcp" />
            </div>
            <div>
              <label className="block text-[10px] uppercase tracking-wide text-[var(--text-secondary)] mb-1">Env (KEY=VALUE per line)</label>
              <textarea
                className="input-field w-full px-2 py-1.5 text-xs font-mono resize-y"
                rows={2}
                value={form.envText}
                onChange={(e) => setForm({ ...form, envText: e.target.value })}
                placeholder={'CREDS_PATH=/path/credentials.yaml'}
              />
            </div>
          </div>
          {/* Credentials (written to a file + injected as an env path on connect) */}
          <div className="rounded-[var(--radius)] border border-[var(--border)] bg-[var(--bg-inset)] p-2.5 space-y-2">
            <div className="flex items-center justify-between">
              <label className="text-[10px] uppercase tracking-wide text-[var(--text-secondary)] flex items-center gap-1.5">
                Credentials file
                {credsSaved && <span className="text-[var(--accent-success)] normal-case tracking-normal">· saved</span>}
              </label>
              <input
                className={`${input} !h-7 !w-40 font-mono text-[11px]`}
                value={form.credsEnvVar}
                onChange={(e) => setForm({ ...form, credsEnvVar: e.target.value })}
                placeholder="CREDS_PATH"
                title="Env var the server reads for its credentials file path"
              />
            </div>
            <textarea
              className="input-field w-full px-2 py-1.5 text-xs font-mono resize-y"
              rows={4}
              value={form.credsContent}
              onChange={(e) => setForm({ ...form, credsContent: e.target.value })}
              placeholder={
                credsSaved
                  ? '•••••••• saved — type to replace the credentials file'
                  : 'Paste the server\'s credentials file (e.g. centralmcp credentials.yaml)…\ncentral_account:\n  client_id: ...\n  client_secret: ...\n  base_url: ...'
              }
            />
            <p className="text-[10px] text-[var(--text-muted)]">
              Stored in the app data dir (outside the browser). On connect it's written to a file and the env var
              above is pointed at it — so you never keep a separate credentials file by hand.
            </p>
          </div>

          <div className="flex items-center justify-end gap-2 pt-1">
            <button
              onClick={() => {
                setShowForm(false);
                setForm({ ...blankForm });
                setCredsSaved(false);
                setEditingName(null);
              }}
              className="px-3 h-8 text-[12px] rounded-md text-[var(--text-secondary)] hover:bg-[var(--bg-tertiary)]"
            >
              Cancel
            </button>
            <button onClick={save} className="btn-accent px-4 h-8 text-[12px]">
              Save
            </button>
          </div>
        </div>
      )}
    </section>
  );
}
