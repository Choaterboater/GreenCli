import { useCallback, useEffect, useState, type CSSProperties } from 'react';
import { invoke } from '@tauri-apps/api/core';
import {
  Plus,
  Trash2,
  Loader2,
  Plug,
  Power,
  PencilLine,
  Copy,
  Server,
  CheckCircle2,
  ClipboardPaste,
  Globe,
  TerminalSquare,
  Eye,
  EyeOff,
  Download,
} from 'lucide-react';
import { notify } from '../store/toastStore';
import { askConfirm } from '../store/dialogStore';
import { useMcpApprovalStore } from '../store/mcpApprovalStore';
import type { McpExportPins, McpServerDef, McpStatus } from '../utils/mcpTypes';
import { plainHttpWarning } from '../utils/urlSafety';
import McpServerSafety from './McpServerSafety';

type McpTransport = McpServerDef['transport'];

/** Forget every "Yes, until GreenCLI closes" answer for a server: it was
 *  reconnected, changed or removed, so its tools must ask again. */
const clearAllowances = (name: string) => useMcpApprovalStore.getState().clearServer(name);
import type { ExportSummary, GreencliExport } from '../utils/mcpExport';
import { isTauri, tauriSave } from '../utils/fileSystem';
import { secretFilterSupported } from '../utils/secrets/support';
import { copyText } from '../utils/clipboard';

/** greencli_mcp_info: GreenCLI's own read-only MCP server, next to the app. */
interface GreencliMcpInfo {
  path: string;
  exists: boolean;
  place: 'normal' | 'translocated' | 'diskImage';
}

/** How the export should treat greencli-mcp. */
function greencliForExport(info: GreencliMcpInfo | null): GreencliExport | undefined {
  if (!info) return undefined;
  if (!info.exists) return { leftOut: 'missing' };
  if (info.place !== 'normal') return { leftOut: 'not-installed' };
  return { command: info.path };
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
  headersText: '',
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
  // Credentials are masked by default; toggle only reveals them while editing.
  const [showCreds, setShowCreds] = useState(false);
  // The name the form was opened on, so a rename can move the server instead of
  // leaving the old name behind as a duplicate.
  const [editingName, setEditingName] = useState<string | null>(null);
  const [showConfigPaste, setShowConfigPaste] = useState(false);
  const [configPasteText, setConfigPasteText] = useState('');
  const [exporting, setExporting] = useState(false);
  const [exportDone, setExportDone] = useState<ExportSummary | null>(null);
  const [greencli, setGreencli] = useState<GreencliMcpInfo | null>(null);
  const [needHidden, setNeedHidden] = useState(0);

  // GreenCLI's own read-only server: where it is, and how many config
  // snapshots it can't serve yet (no hidden copy, or an old one).
  useEffect(() => {
    if (!isTauri) return;
    let cancelled = false;
    void (async () => {
      const info = await invoke<GreencliMcpInfo | null>('greencli_mcp_info').catch(() => null);
      const hidden = await invoke<{ missing: number; stale: number } | null>('config_archive_missing_hidden').catch(
        () => null,
      );
      if (cancelled) return;
      setGreencli(info && typeof info.path === 'string' ? info : null);
      setNeedHidden(hidden ? (hidden.missing ?? 0) + (hidden.stale ?? 0) : 0);
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const copy = async (text: string) => {
    if (await copyText(text)) notify.success('Copied');
    else notify.error('Could not copy');
  };

  const refresh = useCallback(async () => {
    try {
      const defs = (await invoke<McpServerDef[]>('mcp_list_servers')) || [];
      setServers(defs);
      const st = (await invoke<McpStatus[]>('mcp_status')) || [];
      const map: Record<string, McpStatus> = {};
      st.forEach((s) => (map[s.name] = s));
      setStatus(map);
    } catch (err) {
      // Outside Tauri (dev browser / tests) there is no backend at all — stay
      // silent. Real backend failures get logged instead of being swallowed,
      // but not toasted: this runs on a 5s poll and would spam the user.
      if (isTauri) {
        console.error('[McpServers] status refresh failed:', err);
      }
    }
  }, []);

  useEffect(() => {
    refresh();
    // Live status: a server can crash (or the launch auto-connect can finish)
    // while this panel is open — poll so "Connected · N tools" stays truthful.
    const t = setInterval(refresh, 5000);
    return () => clearInterval(t);
  }, [refresh]);

  /** Connects (or restarts) a server; true when it worked. Errors are shown here, never thrown. */
  const connect = async (name: string): Promise<boolean> => {
    setBusy(name);
    clearAllowances(name);
    try {
      const n = await invoke<number>('mcp_connect', { name });
      notify.success(`${name} connected`, `${n} tool${n === 1 ? '' : 's'} now available to the AI`);
      return true;
    } catch (e) {
      notify.error(`${name} failed to connect`, String(e));
      return false;
    } finally {
      setBusy(null);
      refresh();
    }
  };

  const disconnect = async (name: string) => {
    clearAllowances(name);
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
    clearAllowances(name);
    try {
      await invoke('mcp_delete_server', { name });
      notify.info('MCP server removed', name);
    } catch (err) {
      notify.error(`Failed to remove "${name}"`, String(err));
    }
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
      headersText: Object.entries(s.headers || {})
        .map(([k, v]) => `${k}: ${v}`)
        .join('\n'),
      credsContent: '',
      enabled: s.enabled !== false,
    });
    setCredsSaved(false);
    invoke<boolean>('mcp_has_credentials', { name: s.name })
      .then(setCredsSaved)
      .catch(() => setCredsSaved(false));
    setShowConfigPaste(false);
    setConfigPasteText('');
    setShowCreds(false);
    setShowForm(true);
  };

  const duplicate = (s: McpServerDef) => {
    setEditingName(null);
    setForm({
      name: `${s.name} Copy`,
      transport: s.transport === 'http' ? 'http' : 'stdio',
      command: s.command,
      argsText: (s.args || []).join('\n'),
      envText: Object.entries(s.env || {})
        .map(([k, v]) => `${k}=${v}`)
        .join('\n'),
      cwd: s.cwd || '',
      url: s.url || '',
      credsEnvVar: s.credentialsEnvVar || '',
      headersText: Object.entries(s.headers || {})
        .map(([k, v]) => `${k}: ${v}`)
        .join('\n'),
      credsContent: '',
      enabled: s.enabled !== false,
    });
    setCredsSaved(false);
    setShowConfigPaste(false);
    setConfigPasteText('');
    setShowCreds(false);
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
    const headers: Record<string, string> = {};
    form.headersText.split('\n').forEach((line) => {
      const i = line.indexOf(':');
      if (i > 0) headers[line.slice(0, i).trim()] = line.slice(i + 1).trim();
    });
    // Only the fields of the chosen transport: a URL left in the form after switching to stdio
    // would otherwise be saved, hidden, and make the server look like a web server.
    const stdio = form.transport === 'stdio';
    const def: McpServerDef = {
      name,
      transport: form.transport,
      command: stdio ? form.command.trim() : '',
      args: stdio ? args : [],
      env: stdio ? env : {},
      cwd: stdio ? form.cwd.trim() || undefined : undefined,
      url: stdio ? undefined : form.url.trim() || undefined,
      credentialsEnvVar: stdio ? form.credsEnvVar.trim() || undefined : undefined,
      headers: !stdio && Object.keys(headers).length ? headers : undefined,
      enabled: form.enabled,
    };
    // Saving under a name that already belongs to ANOTHER server silently
    // overwrites its config (upsert matches by name) — guard both the
    // new-server path and an edit that retypes the name to collide.
    if (def.name !== editingName && servers.some((s) => s.name === def.name)) {
      notify.warning('Name already in use', `An MCP server named "${def.name}" already exists.`);
      return;
    }
    // Writes go off again when the program changes (Rust McpConfigStore::upsert);
    // remember the setting before the save so the user can be told.
    const writesWereOn = servers.find((s) => s.name === (editingName ?? def.name))?.writes === 'on';
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
      clearAllowances(def.name);
      if (editingName) clearAllowances(editingName);
      notify.success('MCP server saved', def.name);
      if (writesWereOn) {
        const saved = ((await invoke<McpServerDef[]>('mcp_list_servers').catch(() => [])) || []).find(
          (s) => s.name === def.name
        );
        if (saved?.writes === 'off') {
          notify.info(
            `${def.name} writes are off again`,
            "The server's command, folder or URL changed, so GreenCLI turned writes off."
          );
        }
      }
      setShowForm(false);
      setForm({ ...blankForm });
      setCredsSaved(false);
      setShowCreds(false);
      setEditingName(null);
      setShowConfigPaste(false);
      setConfigPasteText('');
      refresh();
    } catch (e) {
      notify.error('Could not save MCP server', String(e));
    }
  };

  // Export for Casper / Claude Code: a .mcp.json with every secret turned into a ${NAME} variable.
  // The secret rules load only after the support check, so an old WebView fails closed.
  const exportServers = async () => {
    if (exporting) return;
    if (!isTauri) {
      notify.info('Export needs the desktop app');
      return;
    }
    if (!secretFilterSupported()) {
      notify.error('Could not export', "This computer can't run GreenCLI's secret check, so nothing was saved.");
      return;
    }
    setExporting(true);
    try {
      const defs = (await invoke<McpServerDef[]>('mcp_list_servers')) || [];
      const withCredentials = new Set<string>();
      await Promise.all(
        defs
          .filter((d) => d.transport !== 'http')
          .map(async (d) => {
            if (await invoke<boolean>('mcp_has_credentials', { name: d.name }).catch(() => false)) withCredentials.add(d.name);
          }),
      );
      // The read-only settings GreenCLI adds while a server's writes are off go in the file too.
      const pinList = await invoke<Record<string, McpExportPins>>('mcp_export_pins').catch(() => ({}));
      const pins = new Map(Object.entries(pinList ?? {}));
      const { buildMcpExport, exportSummary, refusedExportPath, EXPORT_FILE_NAME } = await import('../utils/mcpExport');
      // GreenCLI's own read-only server goes in too, even with no saved servers.
      const info = await invoke<GreencliMcpInfo | null>('greencli_mcp_info').catch(() => null);
      const greencliEntry = greencliForExport(info && typeof info.path === 'string' ? info : null);
      const result = buildMcpExport(defs, { withCredentials, pins, greencli: greencliEntry });
      if (result.count === 0) {
        notify.warning(
          'Nothing to export',
          result.notes.join(' ') || (defs.length ? 'None of these servers can be exported.' : 'Add a server first.'),
        );
        return;
      }
      const path = await tauriSave(EXPORT_FILE_NAME, 'Export MCP servers');
      if (!path) return;
      const refused = refusedExportPath(path);
      if (refused) {
        notify.error('Not saved', refused);
        return;
      }
      // Rust checks the real path again (links, other apps' files) and writes it owner-only.
      await invoke('mcp_export_write', { path, contents: result.text });
      setExportDone(exportSummary(result, path));
      notify.success('MCP servers exported', `${result.count} server${result.count === 1 ? '' : 's'} saved`);
    } catch (e) {
      notify.error('Could not export MCP servers', String(e));
    } finally {
      setExporting(false);
    }
  };

  const input = 'input-field w-full h-8 px-2 text-sm';

  return (
    <section>
      <div className="flex items-center justify-between mb-3">
        <h3 className="text-sm font-semibold text-[var(--text-primary)]">MCP Servers</h3>
        <div className="flex items-center gap-2">
          <button
            onClick={exportServers}
            disabled={exporting}
            title="Save these servers, and GreenCLI's own read-only server, as a .mcp.json file for Casper or Claude Code. Secrets become ${NAME} variables."
            className="flex items-center gap-1.5 px-2.5 py-1 text-[11px] rounded-md bg-[var(--bg-tertiary)] hover:bg-[var(--border-strong)] text-[var(--text-primary)] transition-colors disabled:opacity-50"
          >
            {exporting ? <Loader2 size={13} className="animate-spin" /> : <Download size={13} />}
            Export for Casper / Claude…
          </button>
          <button
            onClick={() => {
              setForm({ ...blankForm });
              setCredsSaved(false);
              setShowCreds(false);
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
      </div>

      <p className="text-[11px] text-[var(--text-secondary)] mb-3 leading-relaxed">
        Connect external <span className="text-[var(--text-primary)]">MCP servers</span> — stdio (launch a command)
        or Streamable HTTP (point at a running server) — to give the AI assistant real tools, e.g. your{' '}
        <code className="text-[var(--accent)]">centralmcp</code> Aruba Central/GLP server. The AI can use these tools with
        every provider except Local CLI and Casper.
      </p>

      {/* GreenCLI's own read-only MCP server (greencli-mcp) */}
      {greencli && (
        <div className="mb-3 p-3 rounded-[var(--radius)] border border-[var(--border)] bg-[var(--bg-inset)] text-[11px] text-[var(--text-secondary)] space-y-1.5 leading-relaxed">
          {greencli.exists ? (
            <>
              <div className="flex items-start gap-2">
                <p className="flex-1 min-w-0">
                  Read-only GreenCLI data for Casper or Claude Code:{' '}
                  <code className="text-[var(--text-primary)] break-all">{greencli.path}</code>
                </p>
                <button
                  onClick={() => void copy(greencli.path)}
                  title="Copy the path"
                  className="flex-shrink-0 flex items-center gap-1 px-1.5 py-0.5 text-[10px] rounded bg-[var(--bg-tertiary)] hover:bg-[var(--border-strong)] text-[var(--text-secondary)]"
                >
                  <Copy size={10} /> Copy
                </button>
              </div>
              <div className="flex items-start gap-2">
                <code className="flex-1 min-w-0 break-all text-[var(--accent)]">
                  {`claude mcp add greencli -- "${greencli.path}"`}
                </code>
                <button
                  onClick={() => void copy(`claude mcp add greencli -- "${greencli.path}"`)}
                  title="Copy the command"
                  className="flex-shrink-0 flex items-center gap-1 px-1.5 py-0.5 text-[10px] rounded bg-[var(--bg-tertiary)] hover:bg-[var(--border-strong)] text-[var(--text-secondary)]"
                >
                  <Copy size={10} /> Copy
                </button>
              </div>
              {greencli.place !== 'normal' && (
                <p className="text-[var(--accent-warning)]">Move GreenCLI to Applications first.</p>
              )}
              {needHidden > 0 && (
                <p>
                  {needHidden} {needHidden === 1 ? 'snapshot needs' : 'snapshots need'} a new hidden copy.
                </p>
              )}
            </>
          ) : (
            <p>greencli-mcp, GreenCLI's read-only server, isn't next to GreenCLI in this build.</p>
          )}
        </div>
      )}

      {/* Export result: names and places only, never a secret value */}
      {exportDone && (
        <div
          role="status"
          className="mb-3 p-3 rounded-[var(--radius)] border border-[var(--border-strong)] bg-[var(--bg-secondary)] text-[11px] text-[var(--text-secondary)] space-y-2 leading-relaxed"
        >
          <div className="text-[12px] font-medium text-[var(--text-primary)] break-all">{exportDone.title}</div>
          <p className="whitespace-pre-line">{exportDone.variablesIntro}</p>
          {exportDone.variables.length > 0 && (
            <ul className="list-disc pl-4 space-y-1">
              {exportDone.variables.map((v) => (
                <li key={v.name}>
                  <code className="text-[var(--accent)]">{v.name}</code>: {v.text}
                </li>
              ))}
            </ul>
          )}
          <p>{exportDone.whereToPut}</p>
          {exportDone.notes.length > 0 && (
            <>
              <p className="text-[var(--text-primary)]">Notes:</p>
              <ul className="list-disc pl-4 space-y-1">
                {exportDone.notes.map((n, i) => (
                  <li key={i}>{n}</li>
                ))}
              </ul>
            </>
          )}
          <p className="text-[var(--text-muted)]">{exportDone.check}</p>
          <div className="flex justify-end">
            <button
              onClick={() => setExportDone(null)}
              className="px-3 h-7 text-[11px] rounded-md bg-[var(--bg-tertiary)] hover:bg-[var(--border-strong)] text-[var(--text-primary)]"
            >
              Done
            </button>
          </div>
        </div>
      )}

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
              className="rounded-[var(--radius)] border border-[var(--border)] bg-[var(--bg-inset)]"
            >
              <div className="flex items-center gap-2 px-3 py-2">
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
                    {connected && (st?.hiddenToolCount ?? 0) > 0 && (
                      <span
                        className="text-[10px] text-[var(--text-muted)]"
                        title={
                          st?.access === 'read-only'
                            ? 'Hidden from the AI because the login is read-only'
                            : 'Hidden from the AI because writes are off'
                        }
                      >
                        · {st?.hiddenToolCount} hidden
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
                  onClick={() => duplicate(s)}
                  className="p-1 rounded-md text-[var(--text-muted)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-tertiary)]"
                  title="Duplicate"
                >
                  <Copy size={12} />
                </button>
                <button
                  onClick={() => remove(s.name)}
                  className="p-1 rounded-md text-[var(--text-muted)] hover:text-[var(--accent-danger)] hover:bg-[var(--bg-tertiary)]"
                  title="Remove"
                >
                  <Trash2 size={12} />
                </button>
              </div>
              <McpServerSafety
                def={s}
                status={st}
                busy={busy === s.name}
                onChanged={refresh}
                onReconnect={connect}
              />
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
              {plainHttpWarning(form.url, 'mcp') && (
                <p className="text-[var(--accent-warning)] text-[10px] mt-1">{plainHttpWarning(form.url, 'mcp')}</p>
              )}
              <p className="text-[10px] text-[var(--text-muted)] mt-1">
                The server must already be running in Streamable HTTP mode (e.g. centralmcp's{' '}
                <code className="text-[var(--accent)]">run_http_router.sh</code>). One process can serve multiple
                clients — nothing is launched or credentialed by this app for HTTP servers.
              </p>
              <div className="mt-2">
                <label className="block text-[10px] uppercase tracking-wide text-[var(--text-secondary)] mb-1">
                  Headers (Key: Value per line — HTTP only)
                </label>
                <textarea
                  className="input-field w-full px-2 py-1.5 text-xs font-mono resize-y"
                  rows={3}
                  value={form.headersText}
                  onChange={(e) => setForm({ ...form, headersText: e.target.value })}
                  placeholder={'Authorization: Bearer your-token-here\nCustom-Header: value'}
                />
                <p className="text-[10px] text-[var(--text-muted)] mt-1">
                  Sent on every request (initialize, tools, SSE listener). Leave empty for no auth.
                </p>
              </div>
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
                  <p className="text-[10px] text-[var(--text-muted)] mt-1 leading-snug">
                    Servers get only a few basic variables from GreenCLI (like PATH, HOME, ssh-agent and proxy settings),
                    plus the ones you add here.
                  </p>
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
                <div className="relative">
                  <textarea
                    className="input-field w-full px-2 py-1.5 text-xs font-mono resize-y pr-8"
                    rows={4}
                    value={form.credsContent}
                    onChange={(e) => setForm({ ...form, credsContent: e.target.value })}
                    style={{ WebkitTextSecurity: showCreds ? 'none' : 'disc' } as CSSProperties}
                    placeholder={
                      credsSaved
                        ? '•••••••• saved — type to replace the credentials file'
                        : 'Paste the server\'s credentials file (e.g. centralmcp credentials.yaml)…\ncentral_account:\n  client_id: ...\n  client_secret: ...\n  base_url: ...'
                    }
                  />
                  <button
                    type="button"
                    onClick={() => setShowCreds((v) => !v)}
                    title={showCreds ? 'Hide credentials' : 'Show credentials'}
                    className="absolute top-1.5 right-1.5 p-1 rounded text-[var(--text-muted)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-tertiary)] transition-colors"
                  >
                    {showCreds ? <EyeOff size={13} /> : <Eye size={13} />}
                  </button>
                </div>
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
