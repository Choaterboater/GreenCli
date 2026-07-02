import { useState, useRef, useCallback, useMemo, useEffect } from 'react';
import { useResizablePanel } from '../hooks/useResizablePanel';
import {
  X,
  Send,
  Globe,
  Link2,
  Clock,
  CheckCircle2,
  AlertCircle,
  ChevronRight,
  ChevronDown,
  TerminalSquare,
  Server,
  Network,
  Tag,
  Radio,
  FileCode,
  Loader2,
  Copy,
  Check,
  Save,
  Trash2,
  Play,
  Table2,
  Braces,
  FileSpreadsheet,
  Download,
} from 'lucide-react';
import { invoke } from '@tauri-apps/api/tauri';
import { useSessionStore } from '../store/sessionStore';
import { useSettingsStore } from '../store/settingsStore';
import { askConfirm } from '../store/dialogStore';
import { notify } from '../store/toastStore';
import {
  ApiConnection,
  ApiEndpoint,
  ApiResponse,
  DeviceApiKind,
  DEFAULT_ENDPOINTS,
  AOSS_ENDPOINTS,
  AOS8_ENDPOINTS,
  JUNOS_ENDPOINTS,
  MIST_ENDPOINTS,
  CENTRAL_ENDPOINTS,
  APSTRA_ENDPOINTS,
  CENTRAL_DOCS,
} from '../types';

// Per-device-REST flavour: label, default base URL, endpoint catalog, and the
// backend login/request commands.
const DEVICE_KINDS: Record<
  DeviceApiKind,
  { label: string; base: (host: string) => string; endpoints: ApiEndpoint[]; loginCmd: string }
> = {
  cx: { label: 'AOS-CX', base: (h) => `https://${h}/rest/v10.09`, endpoints: DEFAULT_ENDPOINTS, loginCmd: 'api_login' },
  aoss: { label: 'AOS-S', base: (h) => `https://${h}/rest/v7`, endpoints: AOSS_ENDPOINTS, loginCmd: 'aoss_login' },
  aos8: { label: 'AOS-8', base: (h) => `https://${h}:4343`, endpoints: AOS8_ENDPOINTS, loginCmd: 'aos8_login' },
  junos: { label: 'Junos', base: (h) => `https://${h}:3443`, endpoints: JUNOS_ENDPOINTS, loginCmd: 'junos_login' },
};

/** Map a connected session's device type to a device REST flavour (best effort). */
function kindForDeviceType(dt?: string): DeviceApiKind | null {
  switch (dt) {
    case 'aruba-cx': return 'cx';
    case 'aruba-aos-s': return 'aoss';
    case 'aruba-controller': return 'aos8';
    case 'juniper-junos': return 'junos';
    default: return null;
  }
}

/** Default Base URL field for a kind (full URL if a host is known, else a hint). */
function defaultBase(k: DeviceApiKind, host?: string): string {
  if (host) return DEVICE_KINDS[k].base(host);
  return k === 'cx' ? '/rest/v10.09' : k === 'aoss' ? '/rest/v7' : '';
}

const IS_TAURI = typeof window !== 'undefined' && '__TAURI_IPC__' in window;
const SAVED_REQUESTS_KEY = 'greencli-api-saved-requests-v1';

interface SavedApiRequest {
  id: string;
  name: string;
  target: 'device' | 'central' | 'apstra' | 'mist';
  deviceKind: DeviceApiKind;
  method: 'GET' | 'POST' | 'PUT' | 'DELETE';
  url: string;
  endpointPath: string;
  requestBody: string;
}

// ── Tabular view of a response body (cencli-style) ──
type Row = Record<string, unknown>;
const isObj = (x: unknown): x is Row => !!x && typeof x === 'object' && !Array.isArray(x);

// Pull a table out of common shapes: a top-level array of objects, a property
// that is an array of objects (e.g. {result:[…]}), or a map name→object
// (AOS-CX depth=2) which becomes rows with a `name` column.
function extractRows(body: unknown): Row[] | null {
  if (Array.isArray(body)) {
    return body.length && body.every(isObj) ? (body as Row[]) : null;
  }
  if (!isObj(body)) return null;
  for (const v of Object.values(body)) {
    if (Array.isArray(v) && v.length && v.every(isObj)) return v as Row[];
  }
  const entries = Object.entries(body);
  if (entries.length && entries.every(([, v]) => isObj(v))) {
    return entries.map(([k, v]) => ({ name: k, ...(v as Row) }));
  }
  return null;
}
/** Columns for on-screen rendering: discovery sampled, count capped so a wide
 *  response doesn't blow out the table. Export paths use `allColumns`. */
function rowColumns(rows: Row[]): string[] {
  const cols: string[] = [];
  for (const r of rows.slice(0, 50)) for (const k of Object.keys(r)) if (!cols.includes(k)) cols.push(k);
  return cols.slice(0, 12);
}
/** Every column across every row — CSV export/copy must not silently drop data
 *  the render caps hide (the UI explicitly promises "export to see all"). */
function allColumns(rows: Row[]): string[] {
  const cols: string[] = [];
  for (const r of rows) for (const k of Object.keys(r)) if (!cols.includes(k)) cols.push(k);
  return cols;
}
function cellText(v: unknown): string {
  if (v == null) return '';
  return typeof v === 'object' ? JSON.stringify(v) : String(v);
}
function toCsv(rows: Row[], cols: string[]): string {
  const neutralizeFormula = (s: string) => (/^\s*[=+\-@]/.test(s) || /^[\t\r]/.test(s) ? `'${s}` : s);
  const esc = (s: string) => {
    const safe = neutralizeFormula(s);
    return /[",\r\n]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
  };
  return [cols.map(esc).join(','), ...rows.map((r) => cols.map((c) => esc(cellText(r[c]))).join(','))].join('\n');
}

async function downloadText(filename: string, contents: string, type = 'text/plain') {
  // Blob-anchor downloads are a silent no-op in the Tauri webview (no download
  // handler) — use the native save dialog there; blob path covers dev-in-browser.
  if (typeof window !== 'undefined' && '__TAURI__' in window) {
    const { save } = await import('@tauri-apps/api/dialog');
    const ext = filename.split('.').pop() || 'txt';
    const path = await save({
      title: 'Export response',
      defaultPath: filename,
      filters: [{ name: ext.toUpperCase(), extensions: [ext] }],
    }).catch(() => null);
    if (!path) return;
    await invoke('write_file_text', { path, contents }).catch(() => {});
    return;
  }
  const blob = new Blob([contents], { type });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

/** Max table rows / JSON chars to render — a huge list endpoint would otherwise
 *  freeze the webview. Full data is still available via CSV export. */
const MAX_RENDER_ROWS = 500;
const MAX_RENDER_JSON = 200_000;
function capJson(text: string): string {
  return text.length > MAX_RENDER_JSON
    ? `${text.slice(0, MAX_RENDER_JSON)}\n… (truncated ${text.length - MAX_RENDER_JSON} more chars — export to see the full body)`
    : text;
}

const CATEGORY_ICONS: Record<string, React.ReactNode> = {
  // On-box (CX REST)
  System: <Server size={14} className="text-[var(--accent)]" />,
  Interfaces: <Network size={14} className="text-[var(--accent-success)]" />,
  VLANs: <Tag size={14} className="text-[var(--accent-warning)]" />,
  LLDP: <Radio size={14} className="text-[#d2a8ff]" />,
  Configuration: <FileCode size={14} className="text-[#e3b341]" />,
  CLI: <TerminalSquare size={14} className="text-[var(--accent-info)]" />,
  // Aruba Central
  Monitoring: <Globe size={14} className="text-[var(--accent)]" />,
  Clients: <Network size={14} className="text-[var(--accent-success)]" />,
  Sites: <Tag size={14} className="text-[var(--accent-warning)]" />,
  'Config Groups': <FileCode size={14} className="text-[#e3b341]" />,
  Firmware: <Server size={14} className="text-[#d2a8ff]" />,
  Alerts: <Radio size={14} className="text-[var(--accent-danger)]" />,
};

const CATEGORY_COLORS: Record<string, string> = {
  System: '#58a6ff', Interfaces: '#3fb950', VLANs: '#d29922',
  LLDP: '#d2a8ff', Configuration: '#e3b341', CLI: '#56d4dd',
  Monitoring: '#58a6ff', Clients: '#3fb950', Sites: '#d29922',
  'Config Groups': '#e3b341', Firmware: '#d2a8ff', Alerts: '#ff7b72',
};

const METHOD_COLORS: Record<string, string> = {
  GET: '#3fb950',
  POST: '#58a6ff',
  PUT: '#d29922',
  DELETE: '#ff7b72',
};

export default function ApiExplorer() {
  const { showApiExplorer, toggleApiExplorer, activeSessionId, sessions } = useSessionStore();
  const verifyDeviceTls = useSettingsStore((s) => s.verifyDeviceTls);
  const [connections, setConnections] = useState<ApiConnection[]>([]);
  const [activeConnectionId, setActiveConnectionId] = useState<string | null>(null);
  const [url, setUrl] = useState('/rest/v10.09');
  const [method, setMethod] = useState<'GET' | 'POST' | 'PUT' | 'DELETE'>('GET');
  const [endpointPath, setEndpointPath] = useState('');
  const [requestBody, setRequestBody] = useState('');
  const [response, setResponse] = useState<ApiResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [expandedCategories, setExpandedCategories] = useState<Set<string>>(new Set(['System', 'Interfaces', 'VLANs', 'CLI']));
  const [copied, setCopied] = useState(false);
  const [viewMode, setViewMode] = useState<'table' | 'json'>('table');
  const [showNewConnection, setShowNewConnection] = useState(false);
  const [newConnHost, setNewConnHost] = useState('');
  const [newConnName, setNewConnName] = useState('');
  const [newConnUser, setNewConnUser] = useState('');
  const [newConnPass, setNewConnPass] = useState('');
  // Default this per-login checkbox from the global "Verify device TLS" setting.
  const [verifyTls, setVerifyTls] = useState(verifyDeviceTls);
  const [target, setTarget] = useState<'device' | 'central' | 'apstra' | 'mist'>('device');
  // Which on-box device REST flavour the "Device REST" target speaks.
  const [deviceKind, setDeviceKind] = useState<DeviceApiKind>('cx');
  const [loggingIn, setLoggingIn] = useState(false);
  const [savedRequests, setSavedRequests] = useState<SavedApiRequest[]>([]);
  // Don't persist until the initial localStorage read has landed — otherwise the
  // first-commit persist writes [] over the saved requests (StrictMode replays
  // the load effect and would then read back the wiped store).
  const [savedRequestsLoaded, setSavedRequestsLoaded] = useState(false);
  const [showSavedRequests, setShowSavedRequests] = useState(false);
  const requestInFlightRef = useRef(false);
  const bodyRef = useRef<HTMLTextAreaElement>(null);

  // Collapsible / Resizable panel state
  const [collapsed, setCollapsed] = useState(false);
  const { width: panelWidth, onDragStart: handleDragStart, handleClass: dragHandleClass } =
    useResizablePanel(420, 200, 800);

  const activeConnection = connections.find((c) => c.id === activeConnectionId);
  const activeSession = sessions.find((s) => s.sessionId === activeSessionId);

  useEffect(() => {
    try {
      const saved = JSON.parse(localStorage.getItem(SAVED_REQUESTS_KEY) || '[]') as SavedApiRequest[];
      if (Array.isArray(saved)) setSavedRequests(saved);
    } catch {
      localStorage.removeItem(SAVED_REQUESTS_KEY);
    } finally {
      setSavedRequestsLoaded(true);
    }
  }, []);

  useEffect(() => {
    if (!savedRequestsLoaded) return;
    localStorage.setItem(SAVED_REQUESTS_KEY, JSON.stringify(savedRequests.slice(0, 50)));
  }, [savedRequests, savedRequestsLoaded]);

  // Auto-fill from active session
  const handleAutofillSession = () => {
    if (!activeSession) return;
    const host = activeSession.config.host;
    if (host) {
      setNewConnHost(host);
      setNewConnName(activeSession.config.name || host);
      setNewConnUser(activeSession.config.username || '');
      // Adapt the REST flavour + base URL to the connected device type instead of
      // always defaulting to AOS-CX /rest/v10.09.
      const k = kindForDeviceType(activeSession.config.deviceType) ?? deviceKind;
      setDeviceKind(k);
      setUrl(DEVICE_KINDS[k].base(host));
    }
  };

  // Group endpoints by category (switches catalog based on target)
  const activeEndpoints =
    target === 'central'
      ? CENTRAL_ENDPOINTS
      : target === 'apstra'
      ? APSTRA_ENDPOINTS
      : target === 'mist'
      ? MIST_ENDPOINTS
      : DEVICE_KINDS[deviceKind].endpoints;
  const groupedEndpoints = activeEndpoints.reduce((acc, ep) => {
    if (!acc[ep.category]) acc[ep.category] = [];
    acc[ep.category].push(ep);
    return acc;
  }, {} as Record<string, ApiEndpoint[]>);

  const toggleCategory = (cat: string) => {
    setExpandedCategories((prev) => {
      const next = new Set(prev);
      if (next.has(cat)) next.delete(cat);
      else next.add(cat);
      return next;
    });
  };

  const selectEndpoint = (ep: ApiEndpoint) => {
    setMethod(ep.method);
    setEndpointPath(ep.path);
    if (ep.body) {
      setRequestBody(JSON.stringify(ep.body, null, 2));
    } else {
      setRequestBody('');
    }
  };

  const executeRequest = useCallback(async () => {
    if (requestInFlightRef.current) return;
    requestInFlightRef.current = true;
    setLoading(true);
    let startTime = performance.now();
    try {
      if (method !== 'GET') {
        const ok = await askConfirm({
          title: `Run ${method} ${endpointPath}?`,
          message:
            'This API request may change device/cloud state. Review the endpoint and request body before continuing.',
          confirmLabel: 'Run request',
          danger: method === 'DELETE',
        });
        if (!ok) return;
      }
      setError(null);
      setResponse(null);
      startTime = performance.now();

      if (!IS_TAURI) {
        throw new Error('The API Explorer runs through the desktop backend — launch the app (not a browser tab).');
      }

      // Route through Rust: handles self-signed certs + cookie/OAuth, no CORS.
      const body = (method === 'POST' || method === 'PUT') && requestBody ? requestBody : null;
      const data =
        target === 'central'
          ? await invoke<{ status: number; body: unknown }>('central_request', {
              method,
              path: endpointPath,
              body,
            })
          : target === 'apstra'
          ? await invoke<{ status: number; body: unknown }>('apstra_request', {
              method,
              path: endpointPath,
              body,
            })
          : target === 'mist'
          ? await invoke<{ status: number; body: unknown }>('mist_request', {
              method,
              path: endpointPath,
              body,
            })
          : await (async () => {
              if (!activeConnection) {
                throw new Error('Connect to a device first (use the Connect button above).');
              }
              const kind = activeConnection.kind ?? deviceKind;
              if (kind === 'aos8') {
                // AOS-8 is showcommand-based — the endpoint "path" holds the CLI
                // command. aos8_show already returns { status, body }; wrapping
                // it again hard-coded status 200 and nested the viewer output.
                return invoke<{ status: number; body: unknown }>('aos8_show', {
                  host: activeConnection.host,
                  command: endpointPath,
                });
              }
              if (kind === 'aoss') {
                // AOS-S client prepends /rest/v7 to a relative path.
                return invoke<{ status: number; body: unknown }>('aoss_request', {
                  host: activeConnection.host,
                  method,
                  path: endpointPath,
                  body,
                });
              }
              if (kind === 'junos') {
                // Junos REST: /rpc/<rpc-name>, HTTP Basic (handled in the backend client).
                return invoke<{ status: number; body: unknown }>('junos_request', {
                  host: activeConnection.host,
                  method,
                  path: endpointPath,
                  body,
                });
              }
              // AOS-CX: honour the editable Base URL (absolute path passthrough),
              // and the session cookie still applies to the same host.
              const base = url.trim().replace(/\/+$/, '');
              const reqPath = /^https?:\/\//i.test(base) ? base + endpointPath : endpointPath;
              return invoke<{ status: number; body: unknown }>('api_request', {
                host: activeConnection.host,
                method,
                path: reqPath,
                body,
              });
            })();

      setResponse({
        status: data.status,
        headers: {},
        body: data.body,
        duration: Math.round(performance.now() - startTime),
      });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      setError(msg);
      setResponse({
        status: 0,
        headers: {},
        body: { error: msg },
        duration: Math.round(performance.now() - startTime),
      });
    } finally {
      requestInFlightRef.current = false;
      setLoading(false);
    }
  }, [endpointPath, method, requestBody, activeConnection, target, url, deviceKind]);

  const saveCurrentRequest = () => {
    if (!endpointPath.trim()) {
      notify.warning('Endpoint required', 'Enter an endpoint path before saving a request.');
      return;
    }
    const label = `${method} ${target}:${endpointPath}`;
    const req: SavedApiRequest = {
      id: `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
      name: label,
      target,
      deviceKind,
      method,
      url,
      endpointPath,
      requestBody,
    };
    setSavedRequests((prev) => [req, ...prev.filter((item) => item.name !== label)].slice(0, 50));
    notify.success('Request saved', label);
  };

  const loadSavedRequest = (req: SavedApiRequest) => {
    setTarget(req.target);
    setDeviceKind(req.deviceKind);
    setMethod(req.method);
    setUrl(req.url);
    setEndpointPath(req.endpointPath);
    setRequestBody(req.requestBody);
    setShowSavedRequests(false);
  };

  const removeSavedRequest = (id: string) => {
    setSavedRequests((prev) => prev.filter((req) => req.id !== id));
  };

  const handleLogin = async () => {
    if (!newConnHost || !newConnUser || loggingIn) return;
    setError(null);
    setLoggingIn(true);
    try {
      if (!IS_TAURI) {
        throw new Error('Login requires the desktop app (the browser can\'t reach the switch directly).');
      }
      // Honour the REST version/base the user typed in the Base URL field, else use
      // the flavour's default — so AOS-S goes to /rest/v7, AOS-8 to the controller,
      // and AOS-CX to v10.09, instead of everything defaulting to CX v10.09.
      const raw = url.trim().replace(/\/+$/, '');
      const fullBase = /^https?:\/\//i.test(raw)
        ? raw
        : raw && raw.startsWith('/')
        ? `https://${newConnHost}${raw}`
        : DEVICE_KINDS[deviceKind].base(newConnHost);
      // Junos REST defaults to :3443 backend-side, but the user's editable
      // Base URL can specify a different port (e.g. https://host:8443) — parse
      // it out and pass it along, or JunosClient always used 3443 regardless
      // of what the field actually said.
      const explicitPort = /^https?:\/\//i.test(fullBase)
        ? Number(new URL(fullBase).port) || undefined
        : undefined;
      // Rust logs in via the right client for this flavour (cookie stored server-side).
      await invoke(DEVICE_KINDS[deviceKind].loginCmd, {
        request: {
          host: newConnHost,
          username: newConnUser,
          password: newConnPass,
          accept_invalid_certs: !verifyTls,
          base_url: fullBase,
          ...(deviceKind === 'junos' && explicitPort ? { port: explicitPort } : {}),
        },
      });

      const id = Math.random().toString(36).slice(2);
      const newConn: ApiConnection = {
        id,
        name: newConnName || newConnHost,
        host: newConnHost,
        username: newConnUser,
        baseUrl: fullBase,
        connected: true,
        kind: deviceKind,
      };

      setConnections((prev) => [...prev, newConn]);
      setActiveConnectionId(id);
      setUrl(newConn.baseUrl);
      setShowNewConnection(false);

      setNewConnHost('');
      setNewConnName('');
      setNewConnUser('');
      setNewConnPass('');
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'Login failed';
      setError(msg);
      notify.error('Login failed', msg);
    } finally {
      setLoggingIn(false);
    }
  };

  const removeConnection = (id: string) => {
    setConnections((prev) => prev.filter((c) => c.id !== id));
    if (activeConnectionId === id) {
      setActiveConnectionId(null);
      setUrl(defaultBase(deviceKind));
    }
  };

  const tableRows = useMemo(() => (response ? extractRows(response.body) : null), [response]);
  const tableCols = useMemo(() => (tableRows ? rowColumns(tableRows) : []), [tableRows]);
  const showTable = viewMode === 'table' && !!tableRows;

  const copyResponse = () => {
    if (!response) return;
    const text = showTable && tableRows ? toCsv(tableRows, allColumns(tableRows)) : JSON.stringify(response.body, null, 2);
    navigator.clipboard.writeText(text);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const exportResponse = (format: 'json' | 'csv') => {
    if (!response) return;
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    if (format === 'csv') {
      if (!tableRows) {
        notify.warning('No table data', 'Switch to JSON export for this response shape.');
        return;
      }
      downloadText(`greencli-api-${stamp}.csv`, toCsv(tableRows, allColumns(tableRows)), 'text/csv');
      return;
    }
    downloadText(
      `greencli-api-${stamp}.json`,
      JSON.stringify(
        {
          request: { target, deviceKind, method, url, endpointPath },
          response,
        },
        null,
        2,
      ),
      'application/json',
    );
  };

  if (!showApiExplorer) return null;

  // Collapsed mode
  if (collapsed) {
    return (
      <div className="w-10 flex-shrink-0 flex flex-col items-center py-3 bg-[var(--bg-primary)] border-l border-[var(--bg-tertiary)] gap-3">
        <button onClick={() => setCollapsed(false)} className="p-2 rounded-lg hover:bg-[var(--bg-tertiary)] text-[var(--accent)] transition-colors" title="Expand API Explorer">
          <Globe size={18} />
        </button>
        <button onClick={toggleApiExplorer} className="p-2 rounded-lg hover:bg-[var(--bg-tertiary)] text-[var(--text-secondary)] hover:text-[var(--accent-danger)] transition-colors" title="Close">
          <X size={16} />
        </button>
      </div>
    );
  }

  return (
    <div className="flex-shrink-0 flex flex-col bg-[var(--bg-primary)] border-l border-[var(--bg-tertiary)] overflow-hidden relative" style={{ width: panelWidth }}>
      {/* Drag Handle */}
      <div className={dragHandleClass} onMouseDown={handleDragStart} />
      {/* Header */}
      <div className="flex items-center justify-between h-10 px-3 pl-4 border-b border-[var(--bg-tertiary)] bg-[var(--bg-secondary)]">
        <div className="flex items-center gap-2">
          <Globe size={14} className="text-[var(--accent)]" />
          <span className="text-xs font-semibold text-[var(--text-primary)] uppercase tracking-wider">
            API Explorer
          </span>
          {loading && (
            <Loader2 size={14} className="animate-spin text-[var(--accent)]" />
          )}
        </div>
        <div className="flex items-center gap-1">
          <button onClick={() => setCollapsed(true)} className="p-1 rounded hover:bg-[var(--bg-tertiary)] text-[var(--text-secondary)] hover:text-[var(--text-primary)]" title="Collapse">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><rect width="18" height="18" x="3" y="3" rx="2"/><path d="M15 3v18"/></svg>
          </button>
          <button onClick={toggleApiExplorer} className="p-1 rounded hover:bg-[var(--bg-tertiary)] text-[var(--text-secondary)] hover:text-[var(--accent-danger)]" title="Close">
            <X size={14} />
          </button>
        </div>
      </div>

      {/* Target toggle: on-box REST · Aruba Central · Juniper Apstra */}
      <div className="flex gap-1 px-3 py-2 border-b border-[var(--bg-tertiary)] bg-[var(--bg-secondary)]">
        {(['device', 'central', 'apstra', 'mist'] as const).map((t) => (
          <button
            key={t}
            onClick={() => setTarget(t)}
            className={`flex-1 py-1 text-[11px] rounded border transition-colors ${
              target === t
                ? 'bg-[var(--bg-tertiary)] border-[var(--accent)] text-[var(--text-primary)]'
                : 'bg-[var(--bg-primary)] border-[var(--border)] text-[var(--text-secondary)]'
            }`}
          >
            {t === 'device' ? 'Device REST' : t === 'central' ? 'Aruba Central' : t === 'apstra' ? 'Apstra' : 'Mist'}
          </button>
        ))}
      </div>

      {/* Device REST flavour: AOS-CX (switch) · AOS-S (switch) · AOS-8 (controller) */}
      {target === 'device' && (
        <div className="flex gap-1 px-3 py-2 border-b border-[var(--bg-tertiary)] bg-[var(--bg-secondary)]">
          {(['cx', 'aoss', 'aos8', 'junos'] as const).map((k) => (
            <button
              key={k}
              onClick={() => {
                setDeviceKind(k);
                setUrl(defaultBase(k, activeConnection?.host || newConnHost || undefined));
              }}
              className={`flex-1 py-1 text-[11px] rounded border transition-colors ${
                deviceKind === k
                  ? 'bg-[var(--bg-tertiary)] border-[var(--accent)] text-[var(--text-primary)]'
                  : 'bg-[var(--bg-primary)] border-[var(--border)] text-[var(--text-secondary)]'
              }`}
            >
              {DEVICE_KINDS[k].label}
            </button>
          ))}
        </div>
      )}

      {/* AOS-8 hint */}
      {target === 'device' && deviceKind === 'aos8' && (
        <div className="px-3 py-2 border-b border-[var(--bg-tertiary)] bg-[var(--bg-secondary)] text-[10px] text-[var(--text-muted)]">
          AOS-8 controllers are queried by <span className="text-[var(--text-secondary)]">showcommand</span> — pick a
          <code className="text-[var(--accent)] mx-1">show …</code>command (or type your own in the endpoint field).
        </div>
      )}

      {/* Junos hint */}
      {target === 'device' && deviceKind === 'junos' && (
        <div className="px-3 py-2 border-b border-[var(--bg-tertiary)] bg-[var(--bg-secondary)] text-[10px] text-[var(--text-muted)]">
          Junos EX/QFX switches use the optional REST API on port 3443 — enable it with
          <code className="text-[var(--accent)] mx-1">set system services rest https</code>. RPCs live at
          <code className="text-[var(--accent)] mx-1">/rpc/…</code>. (Otherwise use the terminal / CLI.)
        </div>
      )}

      {/* Mist hint */}
      {target === 'mist' && (
        <div className="px-3 py-2 border-b border-[var(--bg-tertiary)] bg-[var(--bg-secondary)] text-[10px] text-[var(--text-muted)]">
          Uses the API token from <span className="text-[var(--text-secondary)]">Settings → Juniper Mist</span>. Replace
          <code className="text-[var(--accent)] mx-1">{'{org_id}'}</code>/
          <code className="text-[var(--accent)] mx-1">{'{site_id}'}</code>in paths (run "Whoami" first to find them).
        </div>
      )}

      {/* Apstra hint */}
      {target === 'apstra' && (
        <div className="px-3 py-2 border-b border-[var(--bg-tertiary)] bg-[var(--bg-secondary)] text-[10px] text-[var(--text-muted)]">
          Uses the controller configured in <span className="text-[var(--text-secondary)]">Settings → Juniper Apstra</span>. Replace
          <code className="text-[var(--accent)] mx-1">{'{blueprint_id}'}</code>in paths with a real id (run "Blueprints" first).
        </div>
      )}

      {/* Connection Selector (device target only) */}
      {target === 'device' && (
      <div className="px-3 py-2 border-b border-[var(--bg-tertiary)] bg-[var(--bg-secondary)]">
        {/* One-click use the active SSH session as the API target */}
        {activeSession?.config.host && !activeConnectionId && (
          <button
            onClick={() => {
              handleAutofillSession();
              setShowNewConnection(true);
            }}
            className="w-full mb-2 px-2 py-1 text-xs bg-[#1f6feb22] border border-[var(--accent)] text-[var(--accent)] rounded hover:bg-[#1f6feb44] transition-colors"
          >
            ⚡ Use active session — {activeSession.config.host}
          </button>
        )}
        <div className="flex items-center gap-2 mb-2">
          <Link2 size={12} className="text-[var(--text-secondary)]" />
          <span className="text-xs text-[var(--text-secondary)]">Connection</span>
          {connections.length > 0 && (
            <select
              value={activeConnectionId || ''}
              onChange={(e) => {
                const id = e.target.value;
                setActiveConnectionId(id || null);
                const conn = connections.find((c) => c.id === id);
                if (conn) {
                  setUrl(conn.baseUrl);
                  if (conn.kind) setDeviceKind(conn.kind);
                }
              }}
              className="flex-1 text-xs bg-[var(--bg-primary)] border border-[var(--border)] rounded px-2 py-1 text-[var(--text-primary)] focus:outline-none focus:border-[var(--accent)]"
            >
              <option value="">-- Select --</option>
              {connections.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name} {c.connected ? '(✓)' : '(✗)'}
                </option>
              ))}
            </select>
          )}
          <button
            onClick={() => setShowNewConnection(!showNewConnection)}
            className="px-2 py-1 text-xs bg-[var(--accent)] hover:bg-[var(--accent-hover)] text-white rounded transition-colors"
          >
            {showNewConnection ? 'Cancel' : 'Connect'}
          </button>
          {activeConnection && (
            <button
              onClick={() => removeConnection(activeConnection.id)}
              className="p-1 rounded hover:bg-[var(--bg-tertiary)] text-[var(--accent-danger)]"
            >
              <Trash2 size={12} />
            </button>
          )}
        </div>

        {showNewConnection && (
          <div className="space-y-2 p-2 bg-[var(--bg-primary)] border border-[var(--border)] rounded">
            {activeSession && (
              <button
                onClick={handleAutofillSession}
                className="w-full px-2 py-1 text-xs bg-[var(--bg-tertiary)] hover:bg-[var(--border)] text-[var(--accent)] rounded transition-colors"
              >
                Autofill from active session ({activeSession.config.host})
              </button>
            )}
            <input
              placeholder="Host (e.g. 192.168.1.10)"
              value={newConnHost}
              onChange={(e) => setNewConnHost(e.target.value)}
              className="w-full text-xs bg-[var(--bg-secondary)] border border-[var(--border)] rounded px-2 py-1.5 text-[var(--text-primary)] placeholder-[var(--text-muted)] focus:outline-none focus:border-[var(--accent)]"
            />
            <input
              placeholder="Name (optional)"
              value={newConnName}
              onChange={(e) => setNewConnName(e.target.value)}
              className="w-full text-xs bg-[var(--bg-secondary)] border border-[var(--border)] rounded px-2 py-1.5 text-[var(--text-primary)] placeholder-[var(--text-muted)] focus:outline-none focus:border-[var(--accent)]"
            />
            <input
              placeholder="Username"
              value={newConnUser}
              onChange={(e) => setNewConnUser(e.target.value)}
              className="w-full text-xs bg-[var(--bg-secondary)] border border-[var(--border)] rounded px-2 py-1.5 text-[var(--text-primary)] placeholder-[var(--text-muted)] focus:outline-none focus:border-[var(--accent)]"
            />
            <input
              type="password"
              placeholder="Password"
              value={newConnPass}
              onChange={(e) => setNewConnPass(e.target.value)}
              className="w-full text-xs bg-[var(--bg-secondary)] border border-[var(--border)] rounded px-2 py-1.5 text-[var(--text-primary)] placeholder-[var(--text-muted)] focus:outline-none focus:border-[var(--accent)]"
            />
            <label className="flex items-center gap-2 cursor-pointer select-none">
              <input
                type="checkbox"
                checked={verifyTls}
                onChange={(e) => setVerifyTls(e.target.checked)}
                className="w-3.5 h-3.5 rounded accent-[var(--accent)]"
              />
              <span className="text-[11px] text-[var(--text-secondary)]">
                Verify TLS certificate (off = allow self-signed, default for switches)
              </span>
            </label>
            {error && (
              <div className="px-2 py-1.5 text-[11px] rounded text-[var(--accent-danger)] bg-[rgba(240,83,63,0.08)] border border-[rgba(240,83,63,0.3)]">
                {error}
              </div>
            )}
            <button
              onClick={handleLogin}
              disabled={loggingIn}
              className="w-full flex items-center justify-center gap-1.5 px-2 py-1.5 text-xs bg-[var(--accent)] hover:bg-[var(--accent-hover)] text-white rounded transition-colors disabled:opacity-60"
            >
              {loggingIn && <Loader2 size={12} className="animate-spin" />}
              {loggingIn ? 'Logging in…' : 'Login & Save'}
            </button>
          </div>
        )}
      </div>
      )}

      {/* Endpoint Tree */}
      <div className="flex-1 overflow-y-auto border-b border-[var(--bg-tertiary)]">
        <div className="px-3 py-1.5 text-xs font-semibold text-[var(--text-secondary)] uppercase tracking-wider bg-[var(--bg-secondary)] flex items-center justify-between">
          <span>Endpoints</span>
          <span className="flex items-center gap-1.5">
            <button
              onClick={() => setShowSavedRequests((v) => !v)}
              className="flex items-center gap-1 text-[10px] text-[var(--accent)] hover:underline"
              title="Saved API requests"
            >
              <Save size={10} />
              Saved {savedRequests.length ? `(${savedRequests.length})` : ''}
            </button>
            {target === 'central' && (
              <>
              {CENTRAL_DOCS.map((d) => (
                <a
                  key={d.url}
                  href={d.url}
                  target="_blank"
                  rel="noreferrer"
                  className="text-[10px] text-[var(--accent)] hover:underline"
                  title={d.label}
                >
                  {d.label.split(' ').slice(-2).join(' ')}
                </a>
              ))}
              </>
            )}
          </span>
        </div>
        {showSavedRequests && (
          <div className="border-b border-[var(--border)] bg-[var(--bg-inset)] max-h-64 overflow-y-auto">
            {savedRequests.length === 0 ? (
              <p className="px-3 py-2 text-[11px] text-[var(--text-muted)]">No saved requests yet.</p>
            ) : (
              // Render them all in a scrollable list — a hard slice(0, 8) hid
              // saved requests the counter said existed.
              savedRequests.map((req) => (
                <div key={req.id} className="group flex items-center gap-2 px-3 py-1.5 hover:bg-[var(--bg-tertiary)]">
                  <button onClick={() => loadSavedRequest(req)} className="min-w-0 flex-1 text-left">
                    <div className="truncate text-[11px] text-[var(--text-primary)]">{req.name}</div>
                    <div className="truncate text-[10px] text-[var(--text-muted)]">{req.url}{req.endpointPath}</div>
                  </button>
                  <button
                    onClick={() => removeSavedRequest(req.id)}
                    className="opacity-0 group-hover:opacity-100 p-1 rounded hover:bg-[var(--bg-primary)] text-[var(--text-muted)] hover:text-[var(--accent-danger)]"
                    title="Delete saved request"
                  >
                    <Trash2 size={11} />
                  </button>
                </div>
              ))
            )}
          </div>
        )}
        {Object.entries(groupedEndpoints).map(([category, endpoints]) => (
          <div key={category}>
            <button
              onClick={() => toggleCategory(category)}
              className="flex items-center gap-1.5 w-full px-3 py-1.5 text-left hover:bg-[var(--bg-secondary)] transition-colors"
            >
              {expandedCategories.has(category) ? (
                <ChevronDown size={12} className="text-[var(--text-secondary)]" />
              ) : (
                <ChevronRight size={12} className="text-[var(--text-secondary)]" />
              )}
              {CATEGORY_ICONS[category]}
              <span
                className="text-xs font-medium"
                style={{ color: CATEGORY_COLORS[category] || 'var(--text-secondary)' }}
              >
                {category}
              </span>
              <span className="ml-auto text-[10px] text-[var(--text-muted)]">
                {endpoints.length}
              </span>
            </button>

            {expandedCategories.has(category) &&
              endpoints.map((ep) => (
                <button
                  key={`${ep.method}-${ep.path}-${ep.name}`}
                  onClick={() => selectEndpoint(ep)}
                  className="flex items-start gap-2 w-full px-6 py-1.5 text-left hover:bg-[var(--bg-secondary)] transition-colors group"
                >
                  <span
                    className="text-[10px] font-bold px-1 rounded flex-shrink-0 mt-0.5"
                    style={{
                      background: `${METHOD_COLORS[ep.method]}20`,
                      color: METHOD_COLORS[ep.method],
                    }}
                  >
                    {ep.method}
                  </span>
                  <div className="flex-1 min-w-0">
                    <div className="text-xs text-[var(--text-primary)] truncate">
                      {ep.name}
                    </div>
                    <div className="text-[10px] text-[var(--text-muted)] truncate">
                      {ep.path}
                    </div>
                  </div>
                </button>
              ))}
          </div>
        ))}
      </div>

      {/* Request Builder */}
      <div className="px-3 py-2 border-b border-[var(--bg-tertiary)] space-y-2">
        <div className="flex items-center gap-2">
          <select
            value={method}
            onChange={(e) =>
              setMethod(e.target.value as 'GET' | 'POST' | 'PUT' | 'DELETE')
            }
            className="text-xs bg-[var(--bg-secondary)] border border-[var(--border)] rounded px-2 py-1.5 text-[var(--text-primary)] focus:outline-none focus:border-[var(--accent)]"
          >
            <option value="GET">GET</option>
            <option value="POST">POST</option>
            <option value="PUT">PUT</option>
            <option value="DELETE">DELETE</option>
          </select>
          <input
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            placeholder="Base URL (e.g. https://192.168.1.10/rest/v10.09)"
            className="flex-1 text-xs bg-[var(--bg-secondary)] border border-[var(--border)] rounded px-2 py-1.5 text-[var(--text-primary)] placeholder-[var(--text-muted)] focus:outline-none focus:border-[var(--accent)]"
          />
        </div>
        <input
          value={endpointPath}
          onChange={(e) => setEndpointPath(e.target.value)}
          placeholder="Endpoint path (e.g. /system/interfaces)"
          className="w-full text-xs bg-[var(--bg-secondary)] border border-[var(--border)] rounded px-2 py-1.5 text-[var(--text-primary)] placeholder-[var(--text-muted)] focus:outline-none focus:border-[var(--accent)]"
        />
        {(method === 'POST' || method === 'PUT') && (
          <textarea
            ref={bodyRef}
            value={requestBody}
            onChange={(e) => setRequestBody(e.target.value)}
            placeholder='Request body (JSON)...'
            rows={3}
            className="w-full text-xs bg-[var(--bg-secondary)] border border-[var(--border)] rounded px-2 py-1.5 text-[var(--text-primary)] placeholder-[var(--text-muted)] focus:outline-none focus:border-[var(--accent)] font-mono resize-none"
          />
        )}
        <div className="grid grid-cols-[1fr_auto] gap-2">
          <button
            onClick={executeRequest}
            disabled={loading || !endpointPath}
            className="flex items-center justify-center gap-2 h-8 text-xs bg-[var(--accent)] hover:bg-[var(--accent-hover)] disabled:opacity-50 disabled:hover:bg-[var(--accent)] text-white rounded transition-colors"
          >
            {loading ? (
              <>
                <Loader2 size={12} className="animate-spin" />
                Executing...
              </>
            ) : (
              <>
                <Play size={12} />
                Execute Request
              </>
            )}
          </button>
          <button
            onClick={saveCurrentRequest}
            disabled={!endpointPath}
            className="flex items-center justify-center gap-1.5 h-8 px-2.5 text-xs rounded bg-[var(--bg-tertiary)] hover:bg-[var(--border-strong)] disabled:opacity-50 text-[var(--text-primary)]"
            title="Save this request"
          >
            <Save size={12} />
            Save
          </button>
        </div>
      </div>

      {/* Response Viewer */}
      <div className="flex-1 flex flex-col overflow-hidden min-h-[160px]">
        {response && (
          <>
            <div className="flex items-center justify-between px-3 py-1.5 border-b border-[var(--bg-tertiary)] bg-[var(--bg-secondary)]">
              <div className="flex items-center gap-2">
                {response.status >= 200 && response.status < 300 ? (
                  <CheckCircle2 size={12} className="text-[var(--accent-success)]" />
                ) : response.status >= 400 ? (
                  <AlertCircle size={12} className="text-[var(--accent-danger)]" />
                ) : (
                  <AlertCircle size={12} className="text-[var(--accent-warning)]" />
                )}
                <span
                  className="text-xs font-semibold"
                  style={{
                    color:
                      response.status >= 200 && response.status < 300
                        ? '#3fb950'
                        : response.status >= 400
                        ? '#ff7b72'
                        : '#d29922',
                  }}
                >
                  {response.status || 'Error'}
                </span>
                <span className="flex items-center gap-1 text-[10px] text-[var(--text-muted)]">
                  <Clock size={10} />
                  {response.duration}ms
                </span>
              </div>
              <div className="flex items-center gap-1">
                {tableRows && (
                  <div className="flex items-center rounded-md overflow-hidden border border-[var(--border)]">
                    <button
                      onClick={() => setViewMode('table')}
                      title="Table view"
                      className={`flex items-center px-1.5 py-0.5 ${showTable ? 'bg-[var(--accent-soft)] text-[var(--accent)]' : 'text-[var(--text-secondary)] hover:text-[var(--text-primary)]'}`}
                    >
                      <Table2 size={11} />
                    </button>
                    <button
                      onClick={() => setViewMode('json')}
                      title="JSON view"
                      className={`flex items-center px-1.5 py-0.5 ${!showTable ? 'bg-[var(--accent-soft)] text-[var(--accent)]' : 'text-[var(--text-secondary)] hover:text-[var(--text-primary)]'}`}
                    >
                      <Braces size={11} />
                    </button>
                  </div>
                )}
                <button
                  onClick={copyResponse}
                  title={showTable ? 'Copy as CSV' : 'Copy JSON'}
                  className="flex items-center gap-1 px-2 py-0.5 text-[10px] text-[var(--text-secondary)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-tertiary)] rounded transition-colors"
                >
                  {copied ? (
                    <>
                      <Check size={10} />
                      Copied
                    </>
                  ) : (
                    <>
                      {showTable ? <FileSpreadsheet size={10} /> : <Copy size={10} />}
                      {showTable ? 'CSV' : 'Copy'}
                    </>
                  )}
                </button>
                <button
                  onClick={() => exportResponse('json')}
                  title="Export response as JSON"
                  className="flex items-center gap-1 px-2 py-0.5 text-[10px] text-[var(--text-secondary)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-tertiary)] rounded transition-colors"
                >
                  <Download size={10} />
                  JSON
                </button>
                {tableRows && (
                  <button
                    onClick={() => exportResponse('csv')}
                    title="Export response table as CSV"
                    className="flex items-center gap-1 px-2 py-0.5 text-[10px] text-[var(--text-secondary)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-tertiary)] rounded transition-colors"
                  >
                    <FileSpreadsheet size={10} />
                    CSV
                  </button>
                )}
              </div>
            </div>
            <div className="flex-1 overflow-auto bg-[var(--bg-primary)]">
              {showTable && tableRows ? (
                <>
                <table className="w-full text-[11px] border-collapse">
                  <thead className="sticky top-0 bg-[var(--bg-secondary)]">
                    <tr>
                      {tableCols.map((c) => (
                        <th key={c} className="text-left font-semibold text-[var(--text-secondary)] px-2.5 py-1.5 border-b border-[var(--border)] whitespace-nowrap">
                          {c}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {/* Cap rendered rows so a multi-thousand-object list (clients,
                        MACs, interfaces) can't freeze the webview. */}
                    {tableRows.slice(0, MAX_RENDER_ROWS).map((r, i) => (
                      <tr key={i} className="hover:bg-[var(--bg-tertiary)]">
                        {tableCols.map((c) => (
                          <td
                            key={c}
                            className="px-2.5 py-1 border-b border-[var(--border)] text-[var(--text-primary)] font-mono align-top max-w-[240px] truncate"
                            title={cellText(r[c])}
                          >
                            {cellText(r[c])}
                          </td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
                {tableRows.length > MAX_RENDER_ROWS && (
                  <div className="px-3 py-2 text-[11px] text-[var(--text-muted)] border-t border-[var(--border)]">
                    Showing {MAX_RENDER_ROWS} of {tableRows.length} rows — refine the query or export CSV to see all.
                  </div>
                )}
                </>
              ) : (
                <pre className="text-[11px] font-mono text-[var(--text-primary)] whitespace-pre-wrap break-all p-3">
                  <code>{capJson(JSON.stringify(response.body, null, 2))}</code>
                </pre>
              )}
            </div>
          </>
        )}
        {!response && !error && (
          <div className="flex-1 flex flex-col items-center justify-center text-[var(--text-muted)]">
            <Globe size={24} className="mb-2 opacity-30" />
            <p className="text-xs">Select an endpoint and execute</p>
          </div>
        )}
      </div>
    </div>
  );
}
