import { useState, useRef, useCallback, useEffect } from 'react';
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
} from 'lucide-react';
import { invoke } from '@tauri-apps/api/tauri';
import { useSessionStore } from '../store/sessionStore';
import {
  ApiConnection,
  ApiEndpoint,
  ApiResponse,
  DEFAULT_ENDPOINTS,
  CENTRAL_ENDPOINTS,
  CENTRAL_DOCS,
} from '../types';

const IS_TAURI = typeof window !== 'undefined' && '__TAURI_IPC__' in window;

const CATEGORY_ICONS: Record<string, React.ReactNode> = {
  // On-box (CX REST)
  System: <Server size={14} className="text-[#58a6ff]" />,
  Interfaces: <Network size={14} className="text-[#3fb950]" />,
  VLANs: <Tag size={14} className="text-[#d29922]" />,
  LLDP: <Radio size={14} className="text-[#d2a8ff]" />,
  Configuration: <FileCode size={14} className="text-[#e3b341]" />,
  CLI: <TerminalSquare size={14} className="text-[#56d4dd]" />,
  // Aruba Central
  Monitoring: <Globe size={14} className="text-[#58a6ff]" />,
  Clients: <Network size={14} className="text-[#3fb950]" />,
  Sites: <Tag size={14} className="text-[#d29922]" />,
  'Config Groups': <FileCode size={14} className="text-[#e3b341]" />,
  Firmware: <Server size={14} className="text-[#d2a8ff]" />,
  Alerts: <Radio size={14} className="text-[#ff7b72]" />,
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
  const [showNewConnection, setShowNewConnection] = useState(false);
  const [newConnHost, setNewConnHost] = useState('');
  const [newConnName, setNewConnName] = useState('');
  const [newConnUser, setNewConnUser] = useState('');
  const [newConnPass, setNewConnPass] = useState('');
  const [verifyTls, setVerifyTls] = useState(false);
  const [target, setTarget] = useState<'device' | 'central'>('device');
  const bodyRef = useRef<HTMLTextAreaElement>(null);

  // Collapsible / Resizable panel state
  const [collapsed, setCollapsed] = useState(false);
  const [panelWidth, setPanelWidth] = useState(420);
  const [isDragging, setIsDragging] = useState(false);
  const dragStartX = useRef(0);
  const dragStartWidth = useRef(0);

  // Drag handle for resizing
  const handleDragStart = (e: React.MouseEvent) => {
    setIsDragging(true);
    dragStartX.current = e.clientX;
    dragStartWidth.current = panelWidth;
    e.preventDefault();
  };

  useEffect(() => {
    if (!isDragging) return;
    const handleMouseMove = (e: MouseEvent) => {
      const delta = dragStartX.current - e.clientX;
      setPanelWidth(Math.max(200, Math.min(800, dragStartWidth.current + delta)));
    };
    const handleMouseUp = () => setIsDragging(false);
    window.addEventListener('mousemove', handleMouseMove);
    window.addEventListener('mouseup', handleMouseUp);
    return () => {
      window.removeEventListener('mousemove', handleMouseMove);
      window.removeEventListener('mouseup', handleMouseUp);
    };
  }, [isDragging]);

  const activeConnection = connections.find((c) => c.id === activeConnectionId);
  const activeSession = sessions.find((s) => s.sessionId === activeSessionId);

  // Auto-fill from active session
  const handleAutofillSession = () => {
    if (!activeSession) return;
    const host = activeSession.config.host;
    if (host) {
      setNewConnHost(host);
      setNewConnName(activeSession.config.name || host);
      setNewConnUser(activeSession.config.username || '');
      setUrl(`https://${host}/rest/v10.09`);
    }
  };

  // Group endpoints by category (switches catalog based on target)
  const activeEndpoints = target === 'central' ? CENTRAL_ENDPOINTS : DEFAULT_ENDPOINTS;
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
    setLoading(true);
    setError(null);
    setResponse(null);

    const startTime = performance.now();

    try {
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
          : await (async () => {
              if (!activeConnection) {
                throw new Error('Connect to a device first (use the Connect button above).');
              }
              return invoke<{ status: number; body: unknown }>('api_request', {
                host: activeConnection.host,
                method,
                path: endpointPath,
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
      setLoading(false);
    }
  }, [endpointPath, method, requestBody, activeConnection]);

  const handleLogin = async () => {
    if (!newConnHost || !newConnUser) return;
    setError(null);
    try {
      if (!IS_TAURI) {
        throw new Error('Login requires the desktop app (the browser can\'t reach the switch directly).');
      }
      // Rust client logs in (cookie stored server-side; self-signed certs OK).
      await invoke('api_login', {
        request: {
          host: newConnHost,
          username: newConnUser,
          password: newConnPass,
          accept_invalid_certs: !verifyTls,
        },
      });

      const id = Math.random().toString(36).slice(2);
      const newConn: ApiConnection = {
        id,
        name: newConnName || newConnHost,
        host: newConnHost,
        username: newConnUser,
        baseUrl: `https://${newConnHost}/rest/v10.09`,
        connected: true,
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
    }
  };

  const removeConnection = (id: string) => {
    setConnections((prev) => prev.filter((c) => c.id !== id));
    if (activeConnectionId === id) {
      setActiveConnectionId(null);
      setUrl('/rest/v10.09');
    }
  };

  const copyResponse = () => {
    if (!response) return;
    navigator.clipboard.writeText(JSON.stringify(response.body, null, 2));
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  if (!showApiExplorer) return null;

  // Collapsed mode
  if (collapsed) {
    return (
      <div className="w-10 flex-shrink-0 flex flex-col items-center py-3 bg-[var(--bg-primary)] border-l border-[var(--bg-tertiary)] gap-3">
        <button onClick={() => setCollapsed(false)} className="p-2 rounded-lg hover:bg-[var(--bg-tertiary)] text-[#58a6ff] transition-colors" title="Expand API Explorer">
          <Globe size={18} />
        </button>
        <button onClick={toggleApiExplorer} className="p-2 rounded-lg hover:bg-[var(--bg-tertiary)] text-[var(--text-secondary)] hover:text-[#ff7b72] transition-colors" title="Close">
          <X size={16} />
        </button>
      </div>
    );
  }

  return (
    <div className="flex-shrink-0 flex flex-col bg-[var(--bg-primary)] border-l border-[var(--bg-tertiary)] overflow-hidden relative" style={{ width: panelWidth }}>
      {/* Drag Handle */}
      <div className={`absolute left-0 top-0 bottom-0 w-1 cursor-col-resize z-10 ${isDragging ? 'bg-[#58a6ff]' : 'bg-transparent hover:bg-[#58a6ff60]'} transition-colors`} onMouseDown={handleDragStart} />
      {/* Header */}
      <div className="flex items-center justify-between h-10 px-3 pl-4 border-b border-[var(--bg-tertiary)] bg-[var(--bg-secondary)]">
        <div className="flex items-center gap-2">
          <Globe size={14} className="text-[#58a6ff]" />
          <span className="text-xs font-semibold text-[var(--text-primary)] uppercase tracking-wider">
            API Explorer
          </span>
          {loading && (
            <Loader2 size={14} className="animate-spin text-[#58a6ff]" />
          )}
        </div>
        <div className="flex items-center gap-1">
          <button onClick={() => setCollapsed(true)} className="p-1 rounded hover:bg-[var(--bg-tertiary)] text-[var(--text-secondary)] hover:text-[var(--text-primary)]" title="Collapse">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><rect width="18" height="18" x="3" y="3" rx="2"/><path d="M15 3v18"/></svg>
          </button>
          <button onClick={toggleApiExplorer} className="p-1 rounded hover:bg-[var(--bg-tertiary)] text-[var(--text-secondary)] hover:text-[#ff7b72]" title="Close">
            <X size={14} />
          </button>
        </div>
      </div>

      {/* Target toggle: on-box CX REST vs Aruba Central */}
      <div className="flex gap-1 px-3 py-2 border-b border-[var(--bg-tertiary)] bg-[var(--bg-secondary)]">
        {(['device', 'central'] as const).map((t) => (
          <button
            key={t}
            onClick={() => setTarget(t)}
            className={`flex-1 py-1 text-[11px] rounded border transition-colors ${
              target === t
                ? 'bg-[var(--bg-tertiary)] border-[#58a6ff] text-[var(--text-primary)]'
                : 'bg-[var(--bg-primary)] border-[var(--border)] text-[var(--text-secondary)]'
            }`}
          >
            {t === 'device' ? 'Device (CX REST)' : 'Aruba Central'}
          </button>
        ))}
      </div>

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
            className="w-full mb-2 px-2 py-1 text-xs bg-[#1f6feb22] border border-[#58a6ff] text-[#58a6ff] rounded hover:bg-[#1f6feb44] transition-colors"
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
                if (conn) setUrl(conn.baseUrl);
              }}
              className="flex-1 text-xs bg-[var(--bg-primary)] border border-[var(--border)] rounded px-2 py-1 text-[var(--text-primary)] focus:outline-none focus:border-[#58a6ff]"
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
            className="px-2 py-1 text-xs bg-[#238636] hover:bg-[#2ea043] text-white rounded transition-colors"
          >
            {showNewConnection ? 'Cancel' : 'Connect'}
          </button>
          {activeConnection && (
            <button
              onClick={() => removeConnection(activeConnection.id)}
              className="p-1 rounded hover:bg-[var(--bg-tertiary)] text-[#ff7b72]"
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
                className="w-full px-2 py-1 text-xs bg-[var(--bg-tertiary)] hover:bg-[var(--border)] text-[#58a6ff] rounded transition-colors"
              >
                Autofill from active session ({activeSession.config.host})
              </button>
            )}
            <input
              placeholder="Host (e.g. 192.168.1.10)"
              value={newConnHost}
              onChange={(e) => setNewConnHost(e.target.value)}
              className="w-full text-xs bg-[var(--bg-secondary)] border border-[var(--border)] rounded px-2 py-1.5 text-[var(--text-primary)] placeholder-[var(--text-muted)] focus:outline-none focus:border-[#58a6ff]"
            />
            <input
              placeholder="Name (optional)"
              value={newConnName}
              onChange={(e) => setNewConnName(e.target.value)}
              className="w-full text-xs bg-[var(--bg-secondary)] border border-[var(--border)] rounded px-2 py-1.5 text-[var(--text-primary)] placeholder-[var(--text-muted)] focus:outline-none focus:border-[#58a6ff]"
            />
            <input
              placeholder="Username"
              value={newConnUser}
              onChange={(e) => setNewConnUser(e.target.value)}
              className="w-full text-xs bg-[var(--bg-secondary)] border border-[var(--border)] rounded px-2 py-1.5 text-[var(--text-primary)] placeholder-[var(--text-muted)] focus:outline-none focus:border-[#58a6ff]"
            />
            <input
              type="password"
              placeholder="Password"
              value={newConnPass}
              onChange={(e) => setNewConnPass(e.target.value)}
              className="w-full text-xs bg-[var(--bg-secondary)] border border-[var(--border)] rounded px-2 py-1.5 text-[var(--text-primary)] placeholder-[var(--text-muted)] focus:outline-none focus:border-[#58a6ff]"
            />
            <label className="flex items-center gap-2 cursor-pointer select-none">
              <input
                type="checkbox"
                checked={verifyTls}
                onChange={(e) => setVerifyTls(e.target.checked)}
                className="w-3.5 h-3.5 rounded accent-[#238636]"
              />
              <span className="text-[11px] text-[var(--text-secondary)]">
                Verify TLS certificate (off = allow self-signed, default for switches)
              </span>
            </label>
            <button
              onClick={handleLogin}
              className="w-full px-2 py-1.5 text-xs bg-[#238636] hover:bg-[#2ea043] text-white rounded transition-colors"
            >
              Login & Save
            </button>
          </div>
        )}
      </div>
      )}

      {/* Endpoint Tree */}
      <div className="flex-1 overflow-y-auto border-b border-[var(--bg-tertiary)]">
        <div className="px-3 py-1.5 text-xs font-semibold text-[var(--text-secondary)] uppercase tracking-wider bg-[var(--bg-secondary)] flex items-center justify-between">
          <span>Endpoints</span>
          {target === 'central' && (
            <span className="flex items-center gap-1.5">
              {CENTRAL_DOCS.map((d) => (
                <a
                  key={d.url}
                  href={d.url}
                  target="_blank"
                  rel="noreferrer"
                  className="text-[10px] text-[#58a6ff] hover:underline"
                  title={d.label}
                >
                  {d.label.split(' ').slice(-2).join(' ')}
                </a>
              ))}
            </span>
          )}
        </div>
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
                    <div className="text-xs text-[var(--text-primary)] group-hover:text-white truncate">
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
            className="text-xs bg-[var(--bg-secondary)] border border-[var(--border)] rounded px-2 py-1.5 text-[var(--text-primary)] focus:outline-none focus:border-[#58a6ff]"
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
            className="flex-1 text-xs bg-[var(--bg-secondary)] border border-[var(--border)] rounded px-2 py-1.5 text-[var(--text-primary)] placeholder-[var(--text-muted)] focus:outline-none focus:border-[#58a6ff]"
          />
        </div>
        <input
          value={endpointPath}
          onChange={(e) => setEndpointPath(e.target.value)}
          placeholder="Endpoint path (e.g. /system/interfaces)"
          className="w-full text-xs bg-[var(--bg-secondary)] border border-[var(--border)] rounded px-2 py-1.5 text-[var(--text-primary)] placeholder-[var(--text-muted)] focus:outline-none focus:border-[#58a6ff]"
        />
        {(method === 'POST' || method === 'PUT') && (
          <textarea
            ref={bodyRef}
            value={requestBody}
            onChange={(e) => setRequestBody(e.target.value)}
            placeholder='Request body (JSON)...'
            rows={3}
            className="w-full text-xs bg-[var(--bg-secondary)] border border-[var(--border)] rounded px-2 py-1.5 text-[var(--text-primary)] placeholder-[var(--text-muted)] focus:outline-none focus:border-[#58a6ff] font-mono resize-none"
          />
        )}
        <button
          onClick={executeRequest}
          disabled={loading || !endpointPath}
          className="flex items-center justify-center gap-2 w-full h-8 text-xs bg-[#238636] hover:bg-[#2ea043] disabled:opacity-50 disabled:hover:bg-[#238636] text-white rounded transition-colors"
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
      </div>

      {/* Response Viewer */}
      <div className="flex-1 flex flex-col overflow-hidden min-h-[160px]">
        {response && (
          <>
            <div className="flex items-center justify-between px-3 py-1.5 border-b border-[var(--bg-tertiary)] bg-[var(--bg-secondary)]">
              <div className="flex items-center gap-2">
                {response.status >= 200 && response.status < 300 ? (
                  <CheckCircle2 size={12} className="text-[#3fb950]" />
                ) : response.status >= 400 ? (
                  <AlertCircle size={12} className="text-[#ff7b72]" />
                ) : (
                  <AlertCircle size={12} className="text-[#d29922]" />
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
              <button
                onClick={copyResponse}
                className="flex items-center gap-1 px-2 py-0.5 text-[10px] text-[var(--text-secondary)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-tertiary)] rounded transition-colors"
              >
                {copied ? (
                  <>
                    <Check size={10} />
                    Copied
                  </>
                ) : (
                  <>
                    <Copy size={10} />
                    Copy
                  </>
                )}
              </button>
            </div>
            <div className="flex-1 overflow-auto p-3 bg-[var(--bg-primary)]">
              <pre className="text-[11px] font-mono text-[var(--text-primary)] whitespace-pre-wrap break-all">
                <code>{JSON.stringify(response.body, null, 2)}</code>
              </pre>
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
