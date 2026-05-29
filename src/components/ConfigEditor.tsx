import { useState, useRef, useEffect, useCallback } from 'react';
import Editor, { OnMount } from '@monaco-editor/react';
import type { editor as MonacoEditor } from 'monaco-editor';
import {
  X,
  FileCode,
  Copy,
  Send,
  ChevronDown,
  FolderOpen,
  Download,
  BookOpen,
  FileX,
  Code2,
  Eraser,
} from 'lucide-react';
import { invoke } from '@tauri-apps/api/tauri';
import { useSessionStore } from '../store/sessionStore';

// ─── Tauri / browser file I/O ───

const isTauri = typeof window !== 'undefined' && '__TAURI__' in window;

async function tauriOpen(): Promise<string | null> {
  const { open } = await import('@tauri-apps/api/dialog');
  const result = await open({
    title: 'Open File',
    filters: [{ name: 'All Files', extensions: ['*'] }],
    multiple: false,
  });
  return typeof result === 'string' ? result : null;
}

async function tauriSave(defaultName: string): Promise<string | null> {
  const { save } = await import('@tauri-apps/api/dialog');
  const result = await save({
    title: 'Save File',
    defaultPath: defaultName,
    filters: [{ name: 'All Files', extensions: ['*'] }],
  });
  return result ?? null;
}

// Read/write via Rust commands rather than the webview `fs` API, which is
// scope-limited (it refuses arbitrary paths like ~/Downloads/...) and chokes on
// non-UTF8 bytes common in terminal-capture logs.
async function tauriReadText(path: string): Promise<string> {
  return invoke<string>('read_file_text', { path });
}

async function tauriWriteText(path: string, data: string): Promise<void> {
  await invoke('write_file_text', { path, contents: data });
}

// Strip terminal/ANSI control sequences so captured logs (PuTTY/`show tech`,
// console dumps) are readable instead of full of cursor-movement garbage.
function stripTerminalSequences(text: string): string {
  return text
    // OSC sequences: ESC ] ... (BEL | ST)
    .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, '')
    // CSI sequences: ESC [ ... final-byte  (cursor moves, colours, erase, etc.)
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '')
    // Other two-byte ESC sequences
    .replace(/\x1b[@-Z\\-_]/g, '')
    // Remaining control chars except tab/newline
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, '')
    // Normalise bare CRs
    .replace(/\r\n?/g, '\n');
}

function looksLikeTerminalCapture(text: string): boolean {
  // Sample the first chunk; flag if it contains ESC sequences.
  return /\x1b\[/.test(text.slice(0, 20000));
}

function browserOpen(): Promise<{ name: string; content: string } | null> {
  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    // accept everything
    input.onchange = () => {
      const file = input.files?.[0];
      if (!file) { resolve(null); return; }
      const reader = new FileReader();
      reader.onload = (e) => resolve({ name: file.name, content: e.target?.result as string ?? '' });
      reader.onerror = () => resolve(null);
      reader.readAsText(file);
    };
    input.oncancel = () => resolve(null);
    input.click();
  });
}

function browserSave(content: string, filename: string) {
  const blob = new Blob([content], { type: 'text/plain' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

function basename(path: string): string {
  return path.replace(/\\/g, '/').split('/').pop() || path;
}

// ─── Language detection ───

const EXT_TO_LANG: Record<string, string> = {
  // Aruba / network
  cfg: 'aruba-cx', conf: 'aruba-cx', cli: 'aruba-cx', arubaconfig: 'aruba-cx',
  // Web
  js: 'javascript', mjs: 'javascript', cjs: 'javascript',
  jsx: 'javascript',
  ts: 'typescript', tsx: 'typescript',
  html: 'html', htm: 'html',
  css: 'css', scss: 'scss', less: 'less',
  // Data / config
  json: 'json', jsonc: 'json',
  yaml: 'yaml', yml: 'yaml',
  xml: 'xml', svg: 'xml', xhtml: 'xml',
  toml: 'ini', ini: 'ini',
  // Scripts
  sh: 'shell', bash: 'shell', zsh: 'shell', fish: 'shell',
  ps1: 'powershell', psm1: 'powershell',
  py: 'python', pyw: 'python',
  rb: 'ruby',
  pl: 'perl', pm: 'perl',
  php: 'php',
  lua: 'lua',
  tcl: 'tcl',
  // Systems / compiled
  rs: 'rust',
  go: 'go',
  java: 'java',
  cs: 'csharp',
  cpp: 'cpp', cc: 'cpp', cxx: 'cpp',
  c: 'c',
  h: 'cpp', hpp: 'cpp',
  swift: 'swift',
  kt: 'kotlin', kts: 'kotlin',
  scala: 'scala',
  // Markup / docs
  md: 'markdown', mdx: 'markdown',
  rst: 'restructuredtext',
  tex: 'latex',
  // DB / query
  sql: 'sql', pgsql: 'pgsql', mysql: 'mysql',
  // Infrastructure
  dockerfile: 'dockerfile',
  tf: 'hcl', hcl: 'hcl',
  proto: 'proto',
  // Misc
  r: 'r', R: 'r',
  log: 'plaintext', txt: 'plaintext', text: 'plaintext',
  csv: 'plaintext', tsv: 'plaintext',
};

function detectLanguage(filePath: string): string {
  const name = basename(filePath).toLowerCase();
  // Special filenames
  if (name === 'dockerfile') return 'dockerfile';
  if (name === 'makefile' || name === 'gnumakefile') return 'makefile';
  if (name === '.env' || name.startsWith('.env.')) return 'ini';
  if (name === 'gemfile' || name === 'rakefile') return 'ruby';
  if (name === 'cmakelists.txt') return 'cmake';
  // Extension
  const ext = name.split('.').pop() || '';
  return EXT_TO_LANG[ext] || 'plaintext';
}

// ─── Language list for picker ───

const LANGUAGE_LIST = [
  { id: 'aruba-cx',         label: 'Aruba CX' },
  { id: 'plaintext',        label: 'Plain Text' },
  { id: 'shell',            label: 'Shell / Bash' },
  { id: 'python',           label: 'Python' },
  { id: 'javascript',       label: 'JavaScript' },
  { id: 'typescript',       label: 'TypeScript' },
  { id: 'json',             label: 'JSON' },
  { id: 'yaml',             label: 'YAML' },
  { id: 'xml',              label: 'XML' },
  { id: 'html',             label: 'HTML' },
  { id: 'css',              label: 'CSS' },
  { id: 'markdown',         label: 'Markdown' },
  { id: 'sql',              label: 'SQL' },
  { id: 'rust',             label: 'Rust' },
  { id: 'go',               label: 'Go' },
  { id: 'java',             label: 'Java' },
  { id: 'cpp',              label: 'C / C++' },
  { id: 'csharp',           label: 'C#' },
  { id: 'php',              label: 'PHP' },
  { id: 'ruby',             label: 'Ruby' },
  { id: 'swift',            label: 'Swift' },
  { id: 'kotlin',           label: 'Kotlin' },
  { id: 'powershell',       label: 'PowerShell' },
  { id: 'dockerfile',       label: 'Dockerfile' },
  { id: 'hcl',              label: 'HCL / Terraform' },
  { id: 'ini',              label: 'INI / TOML / .env' },
  { id: 'proto',            label: 'Protobuf' },
];

// ─── Aruba config templates ───

const TEMPLATES: Record<string, string> = {
  'VLAN Config': `! VLAN Configuration
vlan 10
  name MGMT
vlan 20
  name USERS
vlan 30
  name GUEST
vlan 100
  name VOICE
`,
  'Interface Trunk': `! Uplink trunk port
interface 1/1/1
  no shutdown
  description Uplink-Core
  vlan trunk native 10
  vlan trunk allowed 10,20,30,100
`,
  'Interface Access': `! Access port (users)
interface 1/1/3-1/1/48
  no shutdown
  vlan access 20
`,
  'BGP Peer': `! BGP configuration
router bgp 65001
  bgp router-id 10.0.0.1
  neighbor 10.0.0.2 remote-as 65002
  neighbor 10.0.0.2 description Core-Peer
  address-family ipv4 unicast
    neighbor 10.0.0.2 activate
`,
  'OSPF Basic': `! OSPF configuration
router ospf 1
  router-id 10.0.0.1
  area 0.0.0.0
interface vlan 10
  ip ospf 1 area 0.0.0.0
  ip ospf network point-to-point
`,
  'AAA RADIUS': `! RADIUS / AAA
radius-server host 10.0.0.100
  key plaintext MySecret123
  authentication port 1812
  accounting port 1813
aaa authentication login default group radius local
aaa authorization commands default group radius local
`,
};

const ARUBA_KEYWORDS = [
  'show', 'configure', 'interface', 'vlan', 'router', 'ip', 'aaa',
  'ntp', 'snmp', 'logging', 'spanning-tree', 'lacp', 'bgp', 'ospf',
  'no', 'shutdown', 'description', 'access', 'trunk', 'native',
  'allowed', 'remote-as', 'neighbor', 'area', 'network', 'exit',
  'write', 'copy', 'ping', 'traceroute', 'end', 'hostname', 'username',
  'password', 'enable', 'disable', 'default', 'address-family',
  'unicast', 'activate', 'route-map', 'prefix-list', 'permit', 'deny',
];

// ─── Component ───

export default function ConfigEditor() {
  const { showConfigEditor, toggleConfigEditor, activeSessionId, sessions } =
    useSessionStore();

  const [panelWidth, setPanelWidth] = useState(520);
  const [isDragging, setIsDragging] = useState(false);
  const dragStartX = useRef(0);
  const dragStartWidth = useRef(0);

  const [content, setContent] = useState<string>(
    '! Aruba CX Configuration\n! Start typing, open a file, or pick a template\n\n'
  );
  const contentRef = useRef(content);

  const [language, setLanguage] = useState('aruba-cx');
  const [currentFilePath, setCurrentFilePath] = useState<string | null>(null);
  const [isDirty, setIsDirty] = useState(false);

  const [showTemplates, setShowTemplates] = useState(false);
  const [showLangPicker, setShowLangPicker] = useState(false);
  const [langSearch, setLangSearch] = useState('');

  const [sending, setSending] = useState(false);
  const [statusMsg, setStatusMsg] = useState<string | null>(null);

  // Holds the original (uncleaned) text when an opened file had terminal escapes,
  // so the user can toggle back to the raw capture.
  const rawCaptureRef = useRef<string | null>(null);
  const [viewingRaw, setViewingRaw] = useState(false);

  const editorRef = useRef<MonacoEditor.IStandaloneCodeEditor | null>(null);
  const saveFileRef = useRef<(forcePicker?: boolean) => Promise<void>>();
  const openFileRef = useRef<() => Promise<void>>();

  const activeSession = sessions.find((s) => s.sessionId === activeSessionId);

  useEffect(() => { contentRef.current = content; }, [content]);

  const showStatus = (msg: string) => {
    setStatusMsg(msg);
    setTimeout(() => setStatusMsg(null), 3000);
  };

  // ─── File open ───

  // Apply terminal-capture cleaning if needed; returns the text to display.
  const ingest = (name: string, text: string) => {
    if (looksLikeTerminalCapture(text)) {
      rawCaptureRef.current = text;
      setViewingRaw(false);
      const cleaned = stripTerminalSequences(text);
      setContent(cleaned);
      showStatus(`Opened ${name} — cleaned terminal escapes (toggle Raw to see original)`);
    } else {
      rawCaptureRef.current = null;
      setViewingRaw(false);
      setContent(text);
      showStatus(`Opened ${name}`);
    }
  };

  const openFile = useCallback(async () => {
    try {
      if (isTauri) {
        const path = await tauriOpen();
        if (!path) return;
        const text = await tauriReadText(path);
        setLanguage(detectLanguage(path));
        setCurrentFilePath(path);
        setIsDirty(false);
        ingest(basename(path), text);
      } else {
        const result = await browserOpen();
        if (!result) return;
        setLanguage(detectLanguage(result.name));
        setCurrentFilePath(result.name);
        setIsDirty(false);
        ingest(result.name, result.content);
      }
    } catch (e) {
      showStatus(`Open failed: ${e}`);
    }
  }, []);

  // Toggle between the cleaned view and the raw capture.
  const toggleRaw = useCallback(() => {
    const raw = rawCaptureRef.current;
    if (raw == null) return;
    if (viewingRaw) {
      setContent(stripTerminalSequences(raw));
      setViewingRaw(false);
    } else {
      setContent(raw);
      setViewingRaw(true);
    }
  }, [viewingRaw]);

  // Manually strip escapes from whatever is currently in the editor.
  const cleanCurrent = useCallback(() => {
    setContent((c) => stripTerminalSequences(c));
    setIsDirty(true);
    showStatus('Stripped terminal escapes');
  }, []);

  // ─── File save ───

  const saveFile = useCallback(async (forcePicker = false) => {
    const text = contentRef.current;
    try {
      if (isTauri) {
        let path = currentFilePath && !forcePicker ? currentFilePath : null;
        if (!path) {
          const defaultName = currentFilePath ? basename(currentFilePath) : 'untitled.txt';
          path = await tauriSave(defaultName);
        }
        if (!path) return;
        await tauriWriteText(path, text);
        setCurrentFilePath(path);
        setLanguage(detectLanguage(path));
        setIsDirty(false);
        showStatus(`Saved ${basename(path)}`);
      } else {
        const name = currentFilePath ? basename(currentFilePath) : 'untitled.txt';
        browserSave(text, name);
        setIsDirty(false);
        showStatus(`Downloaded ${name}`);
      }
    } catch (e) {
      showStatus(`Save failed: ${e}`);
    }
  }, [currentFilePath]);

  useEffect(() => { saveFileRef.current = saveFile; }, [saveFile]);
  useEffect(() => { openFileRef.current = openFile; }, [openFile]);

  // ─── Monaco mount ───

  const handleEditorMount: OnMount = (ed, monaco) => {
    editorRef.current = ed;

    // Register custom Aruba CX language
    monaco.languages.register({ id: 'aruba-cx' });
    monaco.languages.setMonarchTokensProvider('aruba-cx', {
      keywords: ARUBA_KEYWORDS,
      tokenizer: {
        root: [
          [/^!.*$/, 'comment'],
          [/\b(?:\d{1,3}\.){3}\d{1,3}(?:\/\d{1,2})?\b/, 'number.float'],
          [/\b\d+\/\d+\/\d+\b/, 'type'],
          [/\bvlan\s+\d+\b/, 'keyword'],
          [/\b\d+\b/, 'number'],
          [
            /\b(?:show|configure|interface|vlan|router|ip|aaa|ntp|snmp|bgp|ospf|no|shutdown|description|access|trunk|native|allowed|exit|write|ping|end|hostname|username|password|enable|disable|neighbor|area|network|route-map|prefix-list|permit|deny|address-family|unicast|activate)\b/,
            'keyword',
          ],
          [/".*?"/, 'string'],
          [/'.*?'/, 'string'],
        ],
      },
    } as Parameters<typeof monaco.languages.setMonarchTokensProvider>[1]);

    monaco.editor.defineTheme('aruba-dark', {
      base: 'vs-dark',
      inherit: true,
      rules: [
        { token: 'comment', foreground: '6a737d', fontStyle: 'italic' },
        { token: 'keyword', foreground: 'e06c75' },
        { token: 'number', foreground: '56b6c2' },
        { token: 'number.float', foreground: '98c379' },
        { token: 'type', foreground: 'e5c07b' },
        { token: 'string', foreground: 'abb2bf' },
      ],
      colors: {
        'editor.background': '#0d1117',
        'editor.foreground': '#c9d1d9',
        'editor.lineHighlightBackground': '#161b2240',
        'editor.selectionBackground': '#264f7880',
        'editorLineNumber.foreground': '#484f58',
        'editorLineNumber.activeForeground': '#8b949e',
        'editorCursor.foreground': '#58a6ff',
        'editorWhitespace.foreground': '#30363d',
        'editorIndentGuide.background': '#21262d',
        'editorIndentGuide.activeBackground': '#30363d',
        'scrollbarSlider.background': '#21262d80',
        'scrollbarSlider.hoverBackground': '#30363d',
      },
    });
    monaco.editor.setTheme('aruba-dark');

    // Keybindings
    ed.addAction({
      id: 'save-file',
      label: 'Save File',
      keybindings: [monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS],
      run: () => saveFileRef.current?.(),
    });
    ed.addAction({
      id: 'save-file-as',
      label: 'Save File As…',
      keybindings: [monaco.KeyMod.CtrlCmd | monaco.KeyMod.Shift | monaco.KeyCode.KeyS],
      run: () => saveFileRef.current?.(true),
    });
    ed.addAction({
      id: 'open-file',
      label: 'Open File',
      keybindings: [monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyO],
      run: () => openFileRef.current?.(),
    });
  };

  // ─── Send to terminal ───

  const sendToTerminal = async () => {
    if (!activeSession || !content.trim()) return;
    setSending(true);

    const lines = content
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => l && !l.startsWith('!') && !l.startsWith('#'));

    try {
      for (const line of lines) {
        await invoke('send_data', { sessionId: activeSession.sessionId, data: line + '\n' });
        await new Promise((r) => setTimeout(r, 80));
      }
      showStatus(`Sent ${lines.length} lines`);
    } catch {
      showStatus('Send failed — is a session connected?');
    } finally {
      setSending(false);
    }
  };

  const copyToClipboard = () => {
    navigator.clipboard.writeText(content).catch(() => {});
    showStatus('Copied');
  };

  const loadTemplate = (name: string) => {
    setContent(TEMPLATES[name]);
    setLanguage('aruba-cx');
    setCurrentFilePath(null);
    setIsDirty(false);
    setShowTemplates(false);
  };

  // ─── Resize drag ───

  const handleDragStart = (e: React.MouseEvent) => {
    setIsDragging(true);
    dragStartX.current = e.clientX;
    dragStartWidth.current = panelWidth;
    e.preventDefault();
  };

  useEffect(() => {
    if (!isDragging) return;
    const move = (e: MouseEvent) => {
      const delta = dragStartX.current - e.clientX;
      setPanelWidth(Math.max(300, Math.min(900, dragStartWidth.current + delta)));
    };
    const up = () => setIsDragging(false);
    window.addEventListener('mousemove', move);
    window.addEventListener('mouseup', up);
    return () => {
      window.removeEventListener('mousemove', move);
      window.removeEventListener('mouseup', up);
    };
  }, [isDragging]);

  if (!showConfigEditor) return null;

  const displayName = currentFilePath ? basename(currentFilePath) : null;
  const currentLangLabel = LANGUAGE_LIST.find((l) => l.id === language)?.label || language;
  const filteredLangs = LANGUAGE_LIST.filter((l) =>
    l.label.toLowerCase().includes(langSearch.toLowerCase()) ||
    l.id.toLowerCase().includes(langSearch.toLowerCase())
  );

  return (
    <div
      className="flex-shrink-0 flex flex-col bg-[#0d1117] border-l border-[#21262d] overflow-hidden relative"
      style={{ width: panelWidth }}
    >
      {/* Drag handle */}
      <div
        className={`absolute left-0 top-0 bottom-0 w-1 cursor-col-resize z-10 ${
          isDragging ? 'bg-[#58a6ff]' : 'bg-transparent hover:bg-[#58a6ff60]'
        } transition-colors`}
        onMouseDown={handleDragStart}
      />

      {/* Header */}
      <div className="flex items-center justify-between h-10 px-3 pl-4 border-b border-[#21262d] bg-[#161b22]">
        <div className="flex items-center gap-2 min-w-0">
          <FileCode size={14} className="text-[#e5c07b] flex-shrink-0" />
          <span className="text-xs font-semibold text-[#c9d1d9] uppercase tracking-wider flex-shrink-0">
            Editor
          </span>
          {displayName ? (
            <span className="text-[10px] text-[#8b949e] truncate max-w-[160px]" title={currentFilePath ?? ''}>
              {isDirty && <span className="text-[#e5c07b]">● </span>}{displayName}
            </span>
          ) : (
            <span className="text-[10px] text-[#484f58]">untitled</span>
          )}
        </div>
        <div className="flex items-center gap-1 flex-shrink-0">
          <button onClick={copyToClipboard} className="p-1 rounded hover:bg-[#21262d] text-[#8b949e] hover:text-[#c9d1d9]" title="Copy all">
            <Copy size={13} />
          </button>
          <button onClick={() => { setContent(''); setCurrentFilePath(null); setIsDirty(false); }} className="p-1 rounded hover:bg-[#21262d] text-[#8b949e] hover:text-[#ff7b72]" title="Clear">
            <FileX size={13} />
          </button>
          <button onClick={toggleConfigEditor} className="p-1 rounded hover:bg-[#21262d] text-[#8b949e] hover:text-[#ff7b72]" title="Close">
            <X size={14} />
          </button>
        </div>
      </div>

      {/* Toolbar */}
      <div className="flex items-center gap-1 px-2 py-1 border-b border-[#21262d] bg-[#161b22]">

        {/* File actions — icon-only group with tooltips */}
        <div className="flex items-center gap-0.5">
          <button
            onClick={openFile}
            className="p-1.5 rounded text-[#8b949e] hover:text-[#c9d1d9] hover:bg-[#21262d] transition-colors"
            title="Open file (Ctrl+O)"
          >
            <FolderOpen size={13} />
          </button>
          <button
            onClick={() => saveFile(false)}
            className={`p-1.5 rounded transition-colors ${
              isDirty ? 'text-[#e5c07b] hover:bg-[#e5c07b20]' : 'text-[#8b949e] hover:text-[#c9d1d9] hover:bg-[#21262d]'
            }`}
            title={currentFilePath ? 'Save (Ctrl+S)' : 'Save As… (Ctrl+S)'}
          >
            <Download size={13} />
          </button>
          <button
            onClick={cleanCurrent}
            className="p-1.5 rounded text-[#8b949e] hover:text-[#c9d1d9] hover:bg-[#21262d] transition-colors"
            title="Strip ANSI / terminal control codes"
          >
            <Eraser size={13} />
          </button>
          {rawCaptureRef.current != null && (
            <button
              onClick={toggleRaw}
              className={`px-1.5 py-1 text-[10px] rounded transition-colors ${
                viewingRaw ? 'text-[#e5c07b] bg-[#e5c07b20]' : 'text-[#8b949e] hover:text-[#c9d1d9] hover:bg-[#21262d]'
              }`}
              title="Toggle cleaned / raw capture"
            >
              {viewingRaw ? 'Raw' : 'Clean'}
            </button>
          )}
        </div>

        <div className="w-px h-4 bg-[#30363d] mx-1" />

        {/* Language picker */}
        <div className="relative">
          <button
            onClick={() => { setShowLangPicker(!showLangPicker); setLangSearch(''); setShowTemplates(false); }}
            className="flex items-center gap-1.5 px-2 py-1 text-xs text-[#8b949e] hover:text-[#c9d1d9] hover:bg-[#21262d] rounded transition-colors"
            title="Change language mode"
          >
            <Code2 size={12} />
            <span className="max-w-[80px] truncate">{currentLangLabel}</span>
            <ChevronDown size={10} />
          </button>
          {showLangPicker && (
            <>
              <div className="fixed inset-0 z-20" onClick={() => setShowLangPicker(false)} />
              <div className="absolute top-full left-0 mt-1 z-30 w-48 bg-[#161b22] border border-[#30363d] rounded-lg shadow-xl flex flex-col">
                <div className="p-1.5 border-b border-[#21262d]">
                  <input
                    autoFocus
                    value={langSearch}
                    onChange={(e) => setLangSearch(e.target.value)}
                    placeholder="Filter…"
                    className="w-full text-xs bg-[#0d1117] border border-[#30363d] rounded px-2 py-1 text-[#c9d1d9] placeholder-[#484f58] focus:outline-none focus:border-[#58a6ff]"
                  />
                </div>
                <div className="overflow-y-auto max-h-56 py-1">
                  {filteredLangs.map((l) => (
                    <button
                      key={l.id}
                      onClick={() => { setLanguage(l.id); setShowLangPicker(false); }}
                      className={`flex items-center w-full px-3 py-1.5 text-xs text-left transition-colors ${
                        language === l.id
                          ? 'text-[#58a6ff] bg-[#58a6ff15]'
                          : 'text-[#c9d1d9] hover:bg-[#21262d]'
                      }`}
                    >
                      {l.label}
                    </button>
                  ))}
                  {filteredLangs.length === 0 && (
                    <p className="px-3 py-2 text-xs text-[#484f58]">No match</p>
                  )}
                </div>
              </div>
            </>
          )}
        </div>

        <div className="w-px h-4 bg-[#30363d] mx-0.5" />

        {/* Templates (Aruba only) */}
        <div className="relative">
          <button
            onClick={() => { setShowTemplates(!showTemplates); setShowLangPicker(false); }}
            className="flex items-center gap-1.5 px-2 py-1 text-xs text-[#8b949e] hover:text-[#c9d1d9] hover:bg-[#21262d] rounded transition-colors"
          >
            <BookOpen size={12} />
            Templates
            <ChevronDown size={10} />
          </button>
          {showTemplates && (
            <>
              <div className="fixed inset-0 z-20" onClick={() => setShowTemplates(false)} />
              <div className="absolute top-full left-0 mt-1 z-30 min-w-[160px] bg-[#161b22] border border-[#30363d] rounded-lg shadow-xl py-1">
                {Object.keys(TEMPLATES).map((name) => (
                  <button
                    key={name}
                    onClick={() => loadTemplate(name)}
                    className="flex items-center gap-2 w-full px-3 py-1.5 text-xs text-[#c9d1d9] hover:bg-[#21262d] text-left"
                  >
                    {name}
                  </button>
                ))}
              </div>
            </>
          )}
        </div>

        <div className="flex-1" />

        {statusMsg && <span className="text-[10px] text-[#8b949e] mr-1">{statusMsg}</span>}

        {/* Send to terminal — only shown for aruba-cx */}
        {language === 'aruba-cx' && (
          <button
            onClick={sendToTerminal}
            disabled={sending || !activeSession}
            className="flex items-center gap-1.5 px-2.5 py-1 text-xs bg-[#238636] hover:bg-[#2ea043] disabled:opacity-40 text-white rounded transition-colors"
            title={activeSession ? 'Send lines to terminal' : 'No active session'}
          >
            <Send size={12} />
            {sending ? 'Sending…' : 'Send'}
          </button>
        )}
      </div>

      {/* Monaco Editor */}
      <div className="flex-1 overflow-hidden">
        <Editor
          language={language}
          value={content}
          onChange={(v) => { setContent(v ?? ''); setIsDirty(true); }}
          onMount={handleEditorMount}
          options={{
            fontSize: 13,
            fontFamily: 'JetBrains Mono, Consolas, "Courier New", monospace',
            lineHeight: 20,
            minimap: { enabled: false },
            scrollBeyondLastLine: false,
            wordWrap: 'on',
            tabSize: 2,
            renderLineHighlight: 'gutter',
            cursorBlinking: 'smooth',
            smoothScrolling: true,
            padding: { top: 12, bottom: 12 },
            overviewRulerLanes: 0,
            hideCursorInOverviewRuler: true,
            renderWhitespace: 'none',
            folding: true,
            lineNumbersMinChars: 3,
            contextmenu: true,
            quickSuggestions: true,
            suggestOnTriggerCharacters: true,
            acceptSuggestionOnEnter: 'smart',
            bracketPairColorization: { enabled: true },
            guides: { bracketPairs: true },
          }}
        />
      </div>
    </div>
  );
}
