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
import { useSessionStore } from '../store/sessionStore';
import {
  ApiConnection,
  ApiEndpoint,
  ApiResponse,
  DEFAULT_ENDPOINTS,
} from '../types';

const CATEGORY_ICONS: Record<string, React.ReactNode> = {
  System: <Server size={14} className="text-[#58a6ff]" />,
  Interfaces: <Network size={14} className="text-[#3fb950]" />,
  VLANs: <Tag size={14} className="text-[#d29922]" />,
  LLDP: <Radio size={14} className="text-[#d2a8ff]" />,
  Configuration: <FileCode size={14} className="text-[#e3b341]" />,
  CLI: <TerminalSquare size={14} className="text-[#56d4dd]" />,
};

const CATEGORY_COLORS: Record<string, string> = {
  System: '#58a6ff',
  Interfaces: '#3fb950',
  VLANs: '#d29922',
  LLDP: '#d2a8ff',
  Configuration: '#e3b341',
  CLI: '#56d4dd',
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

  // Group endpoints by category
  const groupedEndpoints = DEFAULT_ENDPOINTS.reduce((acc, ep) => {
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
    const fullUrl = `${url}${endpointPath}`;

    try {
      const headers: Record<string, string> = {
        'Content-Type': 'application/json',
      };

      if (activeConnection?.cookie) {
        headers['Cookie'] = activeConnection.cookie;
      }

      const fetchOptions: RequestInit = {
        method,
        headers,
        credentials: 'include',
        mode: 'cors',
      };

      if ((method === 'POST' || method === 'PUT') && requestBody) {
        try {
          const parsed = JSON.parse(requestBody);
          fetchOptions.body = JSON.stringify(parsed);
        } catch {
          fetchOptions.body = requestBody;
        }
      }

      // In a Tauri app, use the proxy through Rust backend if needed
      // For now we use fetch directly with CORS bypass via Tauri proxy
      const res = await fetch(fullUrl, fetchOptions);

      const bodyText = await res.text();
      let bodyParsed: unknown;
      try {
        bodyParsed = JSON.parse(bodyText);
      } catch {
        bodyParsed = bodyText;
      }

      const headerMap: Record<string, string> = {};
      res.headers.forEach((value, key) => {
        headerMap[key] = value;
      });

      const duration = Math.round(performance.now() - startTime);

      setResponse({
        status: res.status,
        headers: headerMap,
        body: bodyParsed,
        duration,
      });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'Request failed';
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
  }, [url, endpointPath, method, requestBody, activeConnection]);

  const handleLogin = async () => {
    if (!newConnHost || !newConnUser) return;

    const loginUrl = `https://${newConnHost}/rest/v10.09/login`;
    try {
      const res = await fetch(loginUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          username: newConnUser,
          password: newConnPass,
        }),
        credentials: 'include',
      });

      // Extract cookie from response
      const setCookie = res.headers.get('set-cookie') || '';
      const id = Math.random().toString(36).slice(2);
      const newConn: ApiConnection = {
        id,
        name: newConnName || newConnHost,
        host: newConnHost,
        username: newConnUser,
        cookie: setCookie,
        baseUrl: `https://${newConnHost}/rest/v10.09`,
        connected: res.ok,
      };

      setConnections((prev) => [...prev, newConn]);
      setActiveConnectionId(id);
      setUrl(newConn.baseUrl);
      setShowNewConnection(false);

      // Clear form
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
      <div className="w-10 flex-shrink-0 flex flex-col items-center py-3 bg-[#0d1117] border-l border-[#21262d] gap-3">
        <button onClick={() => setCollapsed(false)} className="p-2 rounded-lg hover:bg-[#21262d] text-[#58a6ff] transition-colors" title="Expand API Explorer">
          <Globe size={18} />
        </button>
        <button onClick={toggleApiExplorer} className="p-2 rounded-lg hover:bg-[#21262d] text-[#8b949e] hover:text-[#ff7b72] transition-colors" title="Close">
          <X size={16} />
        </button>
      </div>
    );
  }

  return (
    <div className="flex-shrink-0 flex flex-col bg-[#0d1117] border-l border-[#21262d] overflow-hidden relative" style={{ width: panelWidth }}>
      {/* Drag Handle */}
      <div className={`absolute left-0 top-0 bottom-0 w-1 cursor-col-resize z-10 ${isDragging ? 'bg-[#58a6ff]' : 'bg-transparent hover:bg-[#58a6ff60]'} transition-colors`} onMouseDown={handleDragStart} />
      {/* Header */}
      <div className="flex items-center justify-between h-10 px-3 pl-4 border-b border-[#21262d] bg-[#161b22]">
        <div className="flex items-center gap-2">
          <Globe size={14} className="text-[#58a6ff]" />
          <span className="text-xs font-semibold text-[#c9d1d9] uppercase tracking-wider">
            API Explorer
          </span>
          {loading && (
            <Loader2 size={14} className="animate-spin text-[#58a6ff]" />
          )}
        </div>
        <div className="flex items-center gap-1">
          <button onClick={() => setCollapsed(true)} className="p-1 rounded hover:bg-[#21262d] text-[#8b949e] hover:text-[#c9d1d9]" title="Collapse">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><rect width="18" height="18" x="3" y="3" rx="2"/><path d="M15 3v18"/></svg>
          </button>
          <button onClick={toggleApiExplorer} className="p-1 rounded hover:bg-[#21262d] text-[#8b949e] hover:text-[#ff7b72]" title="Close">
            <X size={14} />
          </button>
        </div>
      </div>

      {/* Connection Selector */}
      <div className="px-3 py-2 border-b border-[#21262d] bg-[#161b22]">
        <div className="flex items-center gap-2 mb-2">
          <Link2 size={12} className="text-[#8b949e]" />
          <span className="text-xs text-[#8b949e]">Connection</span>
          {connections.length > 0 && (
            <select
              value={activeConnectionId || ''}
              onChange={(e) => {
                const id = e.target.value;
                setActiveConnectionId(id || null);
                const conn = connections.find((c) => c.id === id);
                if (conn) setUrl(conn.baseUrl);
              }}
              className="flex-1 text-xs bg-[#0d1117] border border-[#30363d] rounded px-2 py-1 text-[#c9d1d9] focus:outline-none focus:border-[#58a6ff]"
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
              className="p-1 rounded hover:bg-[#21262d] text-[#ff7b72]"
            >
              <Trash2 size={12} />
            </button>
          )}
        </div>

        {showNewConnection && (
          <div className="space-y-2 p-2 bg-[#0d1117] border border-[#30363d] rounded">
            {activeSession && (
              <button
                onClick={handleAutofillSession}
                className="w-full px-2 py-1 text-xs bg-[#21262d] hover:bg-[#30363d] text-[#58a6ff] rounded transition-colors"
              >
                Autofill from active session ({activeSession.config.host})
              </button>
            )}
            <input
              placeholder="Host (e.g. 192.168.1.10)"
              value={newConnHost}
              onChange={(e) => setNewConnHost(e.target.value)}
              className="w-full text-xs bg-[#161b22] border border-[#30363d] rounded px-2 py-1.5 text-[#c9d1d9] placeholder-[#484f58] focus:outline-none focus:border-[#58a6ff]"
            />
            <input
              placeholder="Name (optional)"
              value={newConnName}
              onChange={(e) => setNewConnName(e.target.value)}
              className="w-full text-xs bg-[#161b22] border border-[#30363d] rounded px-2 py-1.5 text-[#c9d1d9] placeholder-[#484f58] focus:outline-none focus:border-[#58a6ff]"
            />
            <input
              placeholder="Username"
              value={newConnUser}
              onChange={(e) => setNewConnUser(e.target.value)}
              className="w-full text-xs bg-[#161b22] border border-[#30363d] rounded px-2 py-1.5 text-[#c9d1d9] placeholder-[#484f58] focus:outline-none focus:border-[#58a6ff]"
            />
            <input
              type="password"
              placeholder="Password"
              value={newConnPass}
              onChange={(e) => setNewConnPass(e.target.value)}
              className="w-full text-xs bg-[#161b22] border border-[#30363d] rounded px-2 py-1.5 text-[#c9d1d9] placeholder-[#484f58] focus:outline-none focus:border-[#58a6ff]"
            />
            <button
              onClick={handleLogin}
              className="w-full px-2 py-1.5 text-xs bg-[#238636] hover:bg-[#2ea043] text-white rounded transition-colors"
            >
              Login & Save
            </button>
          </div>
        )}
      </div>

      {/* Endpoint Tree */}
      <div className="flex-1 overflow-y-auto border-b border-[#21262d]">
        <div className="px-3 py-1.5 text-xs font-semibold text-[#8b949e] uppercase tracking-wider bg-[#161b22]">
          Endpoints
        </div>
        {Object.entries(groupedEndpoints).map(([category, endpoints]) => (
          <div key={category}>
            <button
              onClick={() => toggleCategory(category)}
              className="flex items-center gap-1.5 w-full px-3 py-1.5 text-left hover:bg-[#161b22] transition-colors"
            >
              {expandedCategories.has(category) ? (
                <ChevronDown size={12} className="text-[#8b949e]" />
              ) : (
                <ChevronRight size={12} className="text-[#8b949e]" />
              )}
              {CATEGORY_ICONS[category]}
              <span
                className="text-xs font-medium"
                style={{ color: CATEGORY_COLORS[category] || '#8b949e' }}
              >
                {category}
              </span>
              <span className="ml-auto text-[10px] text-[#484f58]">
                {endpoints.length}
              </span>
            </button>

            {expandedCategories.has(category) &&
              endpoints.map((ep) => (
                <button
                  key={`${ep.method}-${ep.path}-${ep.name}`}
                  onClick={() => selectEndpoint(ep)}
                  className="flex items-start gap-2 w-full px-6 py-1.5 text-left hover:bg-[#161b22] transition-colors group"
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
                    <div className="text-xs text-[#c9d1d9] group-hover:text-white truncate">
                      {ep.name}
                    </div>
                    <div className="text-[10px] text-[#484f58] truncate">
                      {ep.path}
                    </div>
                  </div>
                </button>
              ))}
          </div>
        ))}
      </div>

      {/* Request Builder */}
      <div className="px-3 py-2 border-b border-[#21262d] space-y-2">
        <div className="flex items-center gap-2">
          <select
            value={method}
            onChange={(e) =>
              setMethod(e.target.value as 'GET' | 'POST' | 'PUT' | 'DELETE')
            }
            className="text-xs bg-[#161b22] border border-[#30363d] rounded px-2 py-1.5 text-[#c9d1d9] focus:outline-none focus:border-[#58a6ff]"
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
            className="flex-1 text-xs bg-[#161b22] border border-[#30363d] rounded px-2 py-1.5 text-[#c9d1d9] placeholder-[#484f58] focus:outline-none focus:border-[#58a6ff]"
          />
        </div>
        <input
          value={endpointPath}
          onChange={(e) => setEndpointPath(e.target.value)}
          placeholder="Endpoint path (e.g. /system/interfaces)"
          className="w-full text-xs bg-[#161b22] border border-[#30363d] rounded px-2 py-1.5 text-[#c9d1d9] placeholder-[#484f58] focus:outline-none focus:border-[#58a6ff]"
        />
        {(method === 'POST' || method === 'PUT') && (
          <textarea
            ref={bodyRef}
            value={requestBody}
            onChange={(e) => setRequestBody(e.target.value)}
            placeholder='Request body (JSON)...'
            rows={3}
            className="w-full text-xs bg-[#161b22] border border-[#30363d] rounded px-2 py-1.5 text-[#c9d1d9] placeholder-[#484f58] focus:outline-none focus:border-[#58a6ff] font-mono resize-none"
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
            <div className="flex items-center justify-between px-3 py-1.5 border-b border-[#21262d] bg-[#161b22]">
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
                <span className="flex items-center gap-1 text-[10px] text-[#484f58]">
                  <Clock size={10} />
                  {response.duration}ms
                </span>
              </div>
              <button
                onClick={copyResponse}
                className="flex items-center gap-1 px-2 py-0.5 text-[10px] text-[#8b949e] hover:text-[#c9d1d9] hover:bg-[#21262d] rounded transition-colors"
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
            <div className="flex-1 overflow-auto p-3 bg-[#0d1117]">
              <pre className="text-[11px] font-mono text-[#c9d1d9] whitespace-pre-wrap break-all">
                <code>{JSON.stringify(response.body, null, 2)}</code>
              </pre>
            </div>
          </>
        )}
        {!response && !error && (
          <div className="flex-1 flex flex-col items-center justify-center text-[#484f58]">
            <Globe size={24} className="mb-2 opacity-30" />
            <p className="text-xs">Select an endpoint and execute</p>
          </div>
        )}
      </div>
    </div>
  );
}
