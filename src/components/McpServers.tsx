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
  ClipboardPaste,
  Globe,
  TerminalSquare,
} from 'lucide-react';
import { notify } from '../store/toastStore';
import { askConfirm } from '../store/dialogStore';

type McpTransport = 'stdio' | 'http';

interface McpServerDef {
  name: string;
  transport: McpTransport;
  command: string;
  args: string[];
  env: Record<string, string>;
  cwd?: string;
  url?: string;
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
  transport: 'stdio' as McpTransport,
  command: '',
  argsText: '',
  envText: '',
  cwd: '',
  url: '',
  credsEnvVar: '',
  credsContent: '',
  enabled: true,
};

/** One server entry from a pasted MCP client config, in the shape most tools
 *  (Claude Desktop, this app's own export, centralmcp's setup wizard) emit:
 *  either a bare `{command,args,env,cwd}` / `{url}` object, or the same
 *  wrapped in `{"mcpServers": {"<name>": {...}}}` (or a bare `{"<name>":
 *  {...}}` some tools use without the wrapper key). */
function parseMcpConfigPaste(text: string): Partial<typeof blankForm> | null {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return null;
  }
  if (typeof raw !== 'object' || raw === null) return null;

  const isServerShape = (o: Record<string, unknown>) =>
    typeof o.command === 'string' || typeof o.url === 'string' || o.type === 'http' || o.type === 'stdio';

  let name = '';
  let obj = raw as Record<string, unknown>;
  if (!isServerShape(obj)) {
    // Look for a wrapper: {"mcpServers": {"<name>": {...}}} or a bare
    // {"<name>": {...}} with exactly one entry.
    const container =
      typeof obj.mcpServers === 'object' && obj.mcpServers !== null
        ? (obj.mcpServers as Record<string, unknown>)
        : obj;
    const entries = Object.entries(container);
    if (entries.length !== 1) return null;
    const [key, val] = entries[0];
    if (typeof val !== 'object' || val === null || !isServerShape(val as Record<string, unknown>)) return null;
    name = key;
    obj = val as Record<string, unknown>;
  }

  const isHttp = typeof obj.url === 'string' && obj.url.trim() !== '';
  const patch: Partial<typeof blankForm> = { name: name || undefined };
  if (isHttp) {
    patch.transport = 'http';
    patch.url = String(obj.url).trim();
  } else {
    patch.transport = 'stdio';
    if (typeof obj.command === 'string') patch.command = obj.command;
    if (Array.isArray(obj.args)) patch.argsText = obj.args.map(String).join('\n');
    if (typeof obj.cwd === 'string') patch.cwd = obj.cwd;
    if (typeof obj.env === 'object' && obj.env !== null) {
      patch.envText = Object.entries(obj.env as Record<string, unknown>)
        .map(([k, v]) => `${k}=${v}`)
        .join('\n');
    }
  }
  // Drop the `undefined` name sentinel so callers can spread this directly
  // without clobbering an already-typed Name field.
  if (patch.name === undefined) delete patch.name;
  return patch;
}

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
  const [showConfigPaste, setShowConfigPaste] = useState(false);
  const [configPasteText, setConfigPasteText] = useState('');

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
    // Live status: a server can crash (or the launch auto-connect can finish)
    // while this panel is open — poll so "Connected · N tools" stays truthful.
    const t = setInterval(refresh, 5000);
    return () => clearInterval(t);
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
      transport: s.transport === 'http' ? 'http' : 'stdio',
      command: s.command,
      argsText: (s.args || []).join('\n'),
      envText: Object.entries(s.env || {})
        .map(([k, v]) => `${k}=${v}`)
        .join('\n'),
      cwd: s.cwd || '',
      url: s.url || '',
      credsEnvVar: s.credentialsEnvVar || '',
      credsContent: '',
      enabled: s.enabled !== false,
    });
    invoke<boolean>('mcp_has_credentials', { name: s.name })
      .then(setCredsSaved)
      .catch(() => setCredsSaved(false));
    setShowConfigPaste(false);
    setConfigPasteText('');
    setShowForm(true);
  };

  const applyConfigPaste = () => {
    const patch = parseMcpConfigPaste(configPasteText);
    if (!patch) {
      notify.warning('Could not parse config', 'Paste a JSON object with "command"/"args" (stdio) or "url" (HTTP), optionally wrapped in {"mcpServers": {"name": {...}}}.');
      return;
    }
    setForm((prev) => ({ ...prev, ...patch }));
    setShowConfigPaste(false);
    setConfigPasteText('');
    notify.success('Config applied', 'Review the fields below, then Save.');
  };

  const save = async () => {
    const name = form.name.trim();
    if (!name) {
      notify.warning('Name is required');
      return;
    }
    if (form.transport === 'stdio' && !form.command.trim()) {
      notify.warning('Command is required for a stdio server');
      return;
    }
    if (form.transport === 'http') {
      const u = form.url.trim();
      if (!u) {
        notify.warning('URL is required for an HTTP server');
        return;
      }
      if (!/^https?:\/\//i.test(u)) {
        notify.warning('URL must start with http:// or https://');
        return;
      }
    }
    const args = form.argsText.split('\n').map((s) => s.trim()).filter(Boolean);
    const env: Record<string, string> = {};
    form.envText.split('\n').forEach((line) => {
      const i = line.indexOf('=');
      if (i > 0) env[line.slice(0, i).trim()] = line.slice(i + 1).trim();
    });
    const def: McpServerDef = {
      name,
      transport: form.transport,
      command: form.command.trim(),
      args,
      env,
      cwd: form.cwd.trim() || undefined,
      url: form.url.trim() || undefined,
      credentialsEnvVar: form.credsEnvVar.trim() || undefined,
      enabled: form.enabled,
    };
    // Saving under a name that already belongs to ANOTHER server silently
    // overwrites its config (upsert matches by name) — guard both the
    // new-server path and an edit that retypes the name to collide.
    if (def.name !== editingName && servers.some((s) => s.name === def.name)) {
      notify.warning('Name already in use', `An MCP server named "${def.name}" already exists.`);
      return;
    }
    try {
      // A rename must migrate, not delete-and-recreate: the old save-new +
      // delete-old flow silently wiped the stored credentials (keyed by name)
      // and dropped the live connection.
      if (editingName && editingName !== def.name) {
        await invoke('mcp_rename_server', { from: editingName, to: def.name });
      }
      await invoke('mcp_save_server', { def });
      // Persist credentials content only when the user typed new content (so we
      // never wipe saved creds just because the field is blank on edit). Only
      // meaningful for stdio — Http servers aren't spawned by this app, so
      // there's no process to inject a credentials env var into.
      if (form.transport === 'stdio' && form.credsContent.trim()) {
        await invoke('mcp_set_credentials', { name: def.name, content: form.credsContent });
      }
      notify.success('MCP server saved', def.name);
      setShowForm(false);
      setForm({ ...blankForm });
      setCredsSaved(false);
      setEditingName(null);
      setShowConfigPaste(false);
      setConfigPasteText('');
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
            setShowConfigPaste(false);
            setConfigPasteText('');
            // Not a toggle: clicking "Add server" while an EDIT form is open
            // must open a blank add form, not close the edit form it just reset.
            setShowForm(true);
          }}
          className="flex items-center gap-1.5 px-2.5 py-1 text-[11px] rounded-md bg-[var(--bg-tertiary)] hover:bg-[var(--border-strong)] text-[var(--text-primary)] transition-colors"
        >
          <Plus size={13} />
          Add server
        </button>
      </div>

      <p className="text-[11px] text-[var(--text-secondary)] mb-3 leading-relaxed">
        Connect external <span className="text-[var(--text-primary)]">MCP servers</span> — stdio (launch a command)
        or Streamable HTTP (point at a running server) — to give the AI assistant real tools, e.g. your{' '}
        <code className="text-[var(--accent)]">centralmcp</code> Aruba Central/GLP server. Tools are offered to{' '}
        <em>every</em> AI provider, not just one.
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
              <span className="flex-shrink-0" title={s.transport === 'http' ? 'Streamable HTTP' : 'stdio'}>
                {s.transport === 'http' ? (
                  <Globe size={15} style={{ color: connected ? 'var(--accent)' : 'var(--text-muted)' }} />
                ) : (
                  <Server size={15} style={{ color: connected ? 'var(--accent)' : 'var(--text-muted)' }} />
                )}
              </span>
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <span className="text-[13px] font-medium text-[var(--text-primary)] truncate">{s.name}</span>
                  {connected && (
                    <span className="flex items-center gap-1 text-[10px] text-[var(--accent-success)]">
                      <CheckCircle2 size={10} />
                      {st?.toolCount ?? 0} tool{(st?.toolCount ?? 0) === 1 ? '' : 's'}
                    </span>
                  )}
                </div>
                <div className="text-[10px] text-[var(--text-muted)] font-mono truncate">
                  {s.transport === 'http' ? s.url : `${s.command} ${(s.args || []).join(' ')}`}
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
          {/* Paste config JSON — quick-fill from a setup wizard / Claude-Desktop-style snippet */}
          <div>
            <button
              type="button"
              onClick={() => setShowConfigPaste((v) => !v)}
              className="flex items-center gap-1.5 text-[11px] text-[var(--accent)] hover:underline"
            >
              <ClipboardPaste size={12} />
              {showConfigPaste ? 'Hide paste box' : 'Paste config JSON instead'}
            </button>
            {showConfigPaste && (
              <div className="mt-2 space-y-1.5">
                <textarea
                  className="input-field w-full px-2 py-1.5 text-xs font-mono resize-y"
                  rows={4}
                  value={configPasteText}
                  onChange={(e) => setConfigPasteText(e.target.value)}
                  placeholder={'{\n  "command": "uv",\n  "args": ["run", "python", "mcp_servers/tool_router.py"]\n}\n\nor { "url": "http://127.0.0.1:8010/mcp" }\nor a full {"mcpServers": {"name": {...}}} block'}
                />
                <button type="button" onClick={applyConfigPaste} className="px-2.5 py-1 text-[11px] rounded-md bg-[var(--bg-tertiary)] hover:bg-[var(--border-strong)] text-[var(--text-primary)]">
                  Apply to form
                </button>
              </div>
            )}
          </div>

          <div>
            <label className="block text-[10px] uppercase tracking-wide text-[var(--text-secondary)] mb-1">Name</label>
            <input className={input} value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="centralmcp" />
          </div>

          {/* Transport */}
          <div className="segmented w-full">
            <button
              type="button"
              data-active={form.transport === 'stdio'}
              onClick={() => setForm({ ...form, transport: 'stdio' })}
              className="flex-1 justify-center flex items-center gap-1.5"
            >
              <TerminalSquare size={12} />
              Stdio (launch a command)
            </button>
            <button
              type="button"
              data-active={form.transport === 'http'}
              onClick={() => setForm({ ...form, transport: 'http' })}
              className="flex-1 justify-center flex items-center gap-1.5"
            >
              <Globe size={12} />
              Streamable HTTP
            </button>
          </div>

          {form.transport === 'http' ? (
            <div>
              <label className="block text-[10px] uppercase tracking-wide text-[var(--text-secondary)] mb-1">Server URL</label>
              <input
                className={`${input} font-mono`}
                value={form.url}
                onChange={(e) => setForm({ ...form, url: e.target.value })}
                placeholder="http://127.0.0.1:8010/mcp"
              />
              <p className="text-[10px] text-[var(--text-muted)] mt-1">
                The server must already be running in Streamable HTTP mode (e.g. centralmcp's{' '}
                <code className="text-[var(--accent)]">run_http_router.sh</code>). One process can serve multiple
                clients — nothing is launched or credentialed by this app for HTTP servers.
              </p>
            </div>
          ) : (
            <>
              <div>
                <label className="block text-[10px] uppercase tracking-wide text-[var(--text-secondary)] mb-1">Command</label>
                <input className={`${input} font-mono`} value={form.command} onChange={(e) => setForm({ ...form, command: e.target.value })} placeholder="uv" />
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
            </>
          )}

          <label className="flex items-center gap-2 text-[11px] text-[var(--text-secondary)] cursor-pointer select-none">
            <input
              type="checkbox"
              checked={form.enabled}
              onChange={(e) => setForm({ ...form, enabled: e.target.checked })}
              className="accent-[var(--accent)]"
            />
            Connect automatically when the app starts
          </label>

          <div className="flex items-center justify-end gap-2 pt-1">
            <button
              onClick={() => {
                setShowForm(false);
                setForm({ ...blankForm });
                setCredsSaved(false);
                setEditingName(null);
                setShowConfigPaste(false);
                setConfigPasteText('');
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
