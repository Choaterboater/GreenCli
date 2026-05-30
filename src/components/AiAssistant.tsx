import { useState, useRef, useEffect, useCallback } from 'react';
import {
  X,
  Send,
  Bot,
  User,
  TerminalSquare,
  Sparkles,
  Loader2,
  ChevronDown,
  ChevronRight,
  Clock,
  Settings,
  Terminal,
  AlertCircle,
  CheckCircle2,
} from 'lucide-react';
import { invoke } from '@tauri-apps/api/tauri';
import { useSessionStore } from '../store/sessionStore';
import { useSettingsStore } from '../store/settingsStore';
import { ChatMessage, Session, AiProvider, AI_PROVIDERS } from '../types';
import { sleep, stripAnsi, sendAndCapture } from '../utils/terminal';
import { useResizablePanel } from '../hooks/useResizablePanel';

// ─── Anthropic API types (local) ───

interface AnthropicTextBlock {
  type: 'text';
  text: string;
}

interface AnthropicToolUseBlock {
  type: 'tool_use';
  id: string;
  name: string;
  input: Record<string, unknown>;
}

interface AnthropicToolResultBlock {
  type: 'tool_result';
  tool_use_id: string;
  content: string;
}

type AnthropicContentBlock = AnthropicTextBlock | AnthropicToolUseBlock | AnthropicToolResultBlock;

interface AnthropicMessage {
  role: 'user' | 'assistant';
  content: string | AnthropicContentBlock[];
}

interface ToolExecution {
  name: string;
  args: Record<string, unknown>;
  result: string;
}

interface DisplayMessage extends ChatMessage {
  toolExecutions?: ToolExecution[];
  isError?: boolean;
}

// ─── Aruba CLI Knowledge Base (embedded in system prompt) ───

const ARUBA_KNOWLEDGE = `
## Aruba CX CLI Quick Reference

**Show Commands:**
- show interface brief | show interface <port>
- show vlan | show vlan <id>
- show ip route | show ip route summary
- show lldp neighbors | show lldp neighbor-info <port>
- show spanning-tree | show spanning-tree detail
- show mac-address-table | show mac-address-table vlan <id>
- show running-config | show running-config interface <port>
- show system | show version | show system resource-utilization
- show log | show events | show events severity warning
- show bgp summary | show bgp neighbors | show bgp ipv4 unicast
- show ospf neighbors | show ospf interface | show ospf database
- show lacp interfaces | show lacp aggregates
- show access-list | show access-list statistics | show policy

**Configuration Modes:**
- configure terminal — enter global config
- interface <1/1/1> — interface config
- vlan <id> — VLAN config
- router bgp <asn> — BGP config
- router ospf <id> — OSPF config
- exit — leave current mode
- end — return to exec
- write memory — save config

**VLAN & Interface Patterns:**
- Create VLAN: vlan <id> / name <name>
- Access port: interface <port> / vlan access <id> / no shutdown
- Trunk port: interface <port> / vlan trunk native <id> / vlan trunk allowed <list>
- SVI: interface vlan <id> / ip address <ip>/<prefix> / no shutdown

**Routing:**
- Static route: ip route <prefix>/<len> <nexthop>
- BGP: router bgp <asn> / neighbor <ip> remote-as <asn>
- OSPF: router ospf 1 / area 0.0.0.0 / interface vlan <id> / ip ospf 1 area 0.0.0.0

**AAA / Security:**
- radius-server host <ip> / key plaintext <secret>
- aaa authentication login default group radius local
- username <name> password <pass> role <role>

**Troubleshooting commands:**
- ping <ip> / traceroute <ip>
- debug interface <port> — show debug output
- show tech-support — collect full diagnostics
`;

const SYSTEM_PROMPT = (deviceContext: string, references: string) => `You are Aruba AI, an expert network engineering assistant specializing in Aruba Networks equipment. You help network engineers configure, troubleshoot, and automate Aruba CX switches, Aruba Instant APs, and Aruba Mobility Controllers.

${deviceContext}

${ARUBA_KNOWLEDGE}
${references && references.trim()
  ? `\n## Reference standards (authoritative — apply these and cite them when auditing)\n${references.trim()}\n`
  : ''}

## Guidelines
- Be concise and technical — your users are network engineers
- The send_terminal_command tool RETURNS the device's output to you — run a show command, read the result, then explain or act on it
- Send commands one at a time and interpret each result before the next
- For configuration changes, always confirm with the user before executing — ask "Shall I apply this?"
- Format configs in code blocks for easy copying to the Config Editor panel
- You can execute show/diagnostic commands freely; be cautious with config changes`;

// ─── Prebuilt prompts ───

const PREBUILT_PROMPTS = [
  {
    label: '🛡️ Best-practices audit',
    prompt:
      'Run "show running-config" on the device, then audit it against Aruba best practices. ' +
      'Check at least: management/console security (AAA, local fallback, idle timeout, banner), ' +
      'SNMP (no v1/v2c public/private community, prefer v3), ' +
      'spanning-tree protections (bpdu-guard/root-guard/loop-protect on edge ports, admin-edge), ' +
      'unused/shutdown ports parked in an isolated VLAN, native-VLAN hygiene on trunks, ' +
      'NTP + timezone, syslog/logging configured, password/secret strength, ' +
      'and any default/unsecured services. Report findings as a prioritized list ' +
      '(Critical / Warning / Info), each with the offending config line and the recommended fix command.',
  },
  { label: 'Interface status', prompt: 'Show me all interfaces — which are up/down, speeds, and descriptions.' },
  { label: 'VLAN config', prompt: 'Show the current VLAN configuration including names and port assignments.' },
  { label: 'Troubleshoot connectivity', prompt: 'Walk me through troubleshooting a connectivity issue step by step. Run diagnostic commands on the device.' },
  { label: 'BGP / routing status', prompt: 'Check the routing table and BGP/OSPF neighbor status if configured.' },
];

// ─── Tool definitions ───

const TOOLS = [
  {
    name: 'send_terminal_command',
    description: 'Execute a CLI command on the currently connected Aruba device terminal AND return its captured output back to you. Use freely for show/diagnostic commands to gather information, then analyse the returned output. Always ask the user before running config-changing commands. Tip: disable paging first (e.g. "no page" on AOS-S, or the device may paginate long output).',
    input_schema: {
      type: 'object',
      properties: {
        command: {
          type: 'string',
          description: 'The exact CLI command to execute (e.g., "show interface brief")',
        },
      },
      required: ['command'],
    },
  },
];

// ─── Execute a tool ───

async function executeTool(
  name: string,
  args: Record<string, unknown>,
  activeSession: Session | undefined
): Promise<string> {
  if (name === 'send_terminal_command') {
    const command = (args.command as string) || '';
    if (!activeSession) {
      return 'Error: No active terminal session. Please connect to a device first.';
    }
    if (!activeSession.connected) {
      return 'Error: Terminal session exists but device is not connected.';
    }
    try {
      const cleaned = await sendAndCapture(activeSession.sessionId, command);
      if (!cleaned) {
        return `Command \`${command}\` sent — no output captured (may be interactive, paged, or still running).`;
      }
      // Cap to keep token usage sane; keep the tail (most relevant).
      return cleaned.length > 12000 ? '…(truncated)…\n' + cleaned.slice(-12000) : cleaned;
    } catch (e) {
      return `Failed to run command: ${e}`;
    }
  }
  return `Unknown tool: ${name}`;
}

// All provider network egress goes through the Rust `ai_chat` command so API
// keys never live in the webview. The request body is provider-shaped here; the
// Rust side only adds the base URL + auth header (key pulled from its key store).

// ─── Anthropic (Claude Messages API) with tool-use loop ───

async function callAnthropicWithTools(
  conversationHistory: AnthropicMessage[],
  model: string,
  systemPrompt: string,
  activeSession: Session | undefined,
  onToolCall: (tool: ToolExecution) => void
): Promise<string> {
  const messages = [...conversationHistory];

  for (let iter = 0; iter < 6; iter++) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const data: any = await invoke('ai_chat', {
      request: {
        provider: 'anthropic',
        body: { model, max_tokens: 2048, system: systemPrompt, messages, tools: TOOLS },
      },
    });

    const stopReason: string = data.stop_reason || 'end_turn';
    const content: AnthropicContentBlock[] = data.content || [];

    if (stopReason !== 'tool_use') {
      const textBlock = content.find((b): b is AnthropicTextBlock => b.type === 'text');
      return textBlock?.text || '';
    }

    messages.push({ role: 'assistant', content });

    const toolResults: AnthropicToolResultBlock[] = [];
    for (const block of content) {
      if (block.type === 'tool_use') {
        const toolBlock = block as AnthropicToolUseBlock;
        const result = await executeTool(toolBlock.name, toolBlock.input, activeSession);
        onToolCall({ name: toolBlock.name, args: toolBlock.input, result });
        toolResults.push({ type: 'tool_result', tool_use_id: toolBlock.id, content: result });
      }
    }

    messages.push({ role: 'user', content: toolResults });
  }

  throw new Error('Exceeded tool call limit (6 iterations)');
}

// ─── OpenAI-compatible providers (OpenRouter / Moonshot-Kimi / Ollama) ───

interface OpenAiToolCall {
  id: string;
  type: 'function';
  function: { name: string; arguments: string };
}

async function callOpenAiCompatWithTools(
  provider: 'openrouter' | 'moonshot' | 'ollama',
  baseUrl: string | undefined,
  model: string,
  conversationHistory: AnthropicMessage[],
  systemPrompt: string,
  activeSession: Session | undefined,
  onToolCall: (tool: ToolExecution) => void
): Promise<string> {
  const toOpenAi = (m: AnthropicMessage) => ({
    role: m.role,
    content:
      typeof m.content === 'string'
        ? m.content
        : (m.content as AnthropicContentBlock[])
            .filter((b): b is AnthropicTextBlock => b.type === 'text')
            .map((b) => b.text)
            .join('\n') || '',
  });

  const messages: unknown[] = [
    { role: 'system', content: systemPrompt },
    ...conversationHistory.map(toOpenAi),
  ];

  const tools = TOOLS.map((t) => ({
    type: 'function',
    function: { name: t.name, description: t.description, parameters: t.input_schema },
  }));

  for (let iter = 0; iter < 6; iter++) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const data: any = await invoke('ai_chat', {
      request: {
        provider,
        base_url: provider === 'ollama' ? baseUrl : undefined,
        body: { model, messages, tools, stream: false },
      },
    });

    const choice = data.choices?.[0];
    const msg = choice?.message;
    if (!msg) throw new Error('Empty response from provider');

    const finishReason: string = choice?.finish_reason || 'stop';
    if (finishReason !== 'tool_calls' || !msg.tool_calls?.length) {
      return msg.content || '';
    }

    messages.push({ role: 'assistant', content: msg.content ?? null, tool_calls: msg.tool_calls });

    for (const tc of msg.tool_calls as OpenAiToolCall[]) {
      let args: Record<string, unknown> = {};
      try {
        args = JSON.parse(tc.function.arguments);
      } catch {
        /* ignore malformed args */
      }
      const result = await executeTool(tc.function.name, args, activeSession);
      onToolCall({ name: tc.function.name, args, result });
      messages.push({ role: 'tool', tool_call_id: tc.id, content: result });
    }
  }

  throw new Error('Exceeded tool call limit');
}

// ─── Local CLI passthrough with auto-command execution ───

async function callLocalCli(
  command: string,
  conversationHistory: AnthropicMessage[],
  _systemPrompt: string,
  activeSession?: Session
): Promise<string> {
  // Fetch recent terminal output so the CLI AI has device context
  let terminalContext = '';
  if (activeSession?.connected) {
    try {
      const output = await invoke<string>('get_terminal_output', {
        sessionId: activeSession.sessionId,
      });
      if (output && output.trim()) {
        const tail = output.length > 3000 ? output.slice(-3000) : output;
        terminalContext = `\nRecent terminal output:\n${tail}\n`;
      }
    } catch { /* ignore */ }
  }

  // Only the last user message matters for a one-shot CLI call
  const lastUser = [...conversationHistory]
    .reverse()
    .find((m) => m.role === 'user');
  const question = lastUser
    ? typeof lastUser.content === 'string'
      ? lastUser.content
      : (lastUser.content as AnthropicContentBlock[])
          .filter((b): b is AnthropicTextBlock => b.type === 'text')
          .map((b) => b.text)
          .join('\n')
    : '';

  const device = activeSession
    ? `Connected to: ${activeSession.config.name} (${activeSession.config.host}, ${activeSession.config.deviceType})`
    : 'No device connected.';

  const prompt = `${device}${terminalContext}\n${question}`;

  return await invoke<string>('ai_cli', { command, prompt });
}

// ─── Build device context string ───

function buildDeviceContext(activeSession: Session | undefined): string {
  if (!activeSession) return 'No device currently connected.';
  return [
    `Active Device: ${activeSession.config.name}`,
    `Host: ${activeSession.config.host || 'N/A'}`,
    `Type: ${activeSession.config.deviceType}`,
    `Status: ${activeSession.connected ? 'Connected' : 'Disconnected'}`,
  ].join(' | ');
}

// ─── Simple markdown renderer ───

function renderMarkdown(text: string) {
  const lines = text.split('\n');
  const result: JSX.Element[] = [];
  let i = 0;
  let key = 0;

  while (i < lines.length) {
    const line = lines[i];

    // Code fence
    if (line.startsWith('```')) {
      const lang = line.slice(3).trim();
      const codeLines: string[] = [];
      i++;
      while (i < lines.length && !lines[i].startsWith('```')) {
        codeLines.push(lines[i]);
        i++;
      }
      result.push(
        <pre key={key++} className="my-2 p-3 bg-[var(--bg-primary)] border border-[var(--border)] rounded-lg overflow-x-auto">
          <code className="text-[11px] text-[var(--text-primary)] font-mono whitespace-pre">
            {codeLines.join('\n')}
          </code>
        </pre>
      );
      i++;
      continue;
    }

    // Heading
    if (line.startsWith('## ')) {
      result.push(<h4 key={key++} className="text-xs font-bold text-[var(--text-primary)] mt-2 mb-1">{line.slice(3)}</h4>);
      i++;
      continue;
    }
    if (line.startsWith('# ')) {
      result.push(<h3 key={key++} className="text-sm font-bold text-white mt-2 mb-1">{line.slice(2)}</h3>);
      i++;
      continue;
    }

    // Horizontal rule
    if (line.match(/^---+$/)) {
      result.push(<hr key={key++} className="border-[var(--border)] my-2" />);
      i++;
      continue;
    }

    // Empty line
    if (line.trim() === '') {
      result.push(<div key={key++} className="h-1" />);
      i++;
      continue;
    }

    // Normal text with inline formatting
    result.push(<p key={key++} className="text-[11px] leading-relaxed">{renderInline(line)}</p>);
    i++;
  }

  return result;
}

function renderInline(text: string): (JSX.Element | string)[] {
  const parts: (JSX.Element | string)[] = [];
  const re = /(\*\*[^*]+\*\*|`[^`]+`|\*[^*]+\*)/g;
  let last = 0;
  let m: RegExpExecArray | null;
  let k = 0;

  while ((m = re.exec(text)) !== null) {
    if (m.index > last) parts.push(text.slice(last, m.index));
    const tok = m[0];
    if (tok.startsWith('**')) {
      parts.push(<strong key={k++} className="text-white font-semibold">{tok.slice(2, -2)}</strong>);
    } else if (tok.startsWith('`')) {
      parts.push(<code key={k++} className="px-1 py-0.5 bg-[var(--bg-primary)] border border-[var(--border)] rounded text-[#d29922] text-[10px] font-mono">{tok.slice(1, -1)}</code>);
    } else if (tok.startsWith('*')) {
      parts.push(<em key={k++} className="italic">{tok.slice(1, -1)}</em>);
    }
    last = m.index + tok.length;
  }
  if (last < text.length) parts.push(text.slice(last));
  return parts;
}

// ─── Component ───

export default function AiAssistant() {
  const { showAiAssistant, toggleAiAssistant, activeSessionId, sessions } = useSessionStore();
  const settings = useSettingsStore();

  const { width: panelWidth, onDragStart: handleDragStart, handleClass: dragHandleClass } =
    useResizablePanel(420, 300, 800);

  const [messages, setMessages] = useState<DisplayMessage[]>([]);
  const [input, setInput] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const [expandedTools, setExpandedTools] = useState<Set<number>>(new Set());
  const [hasKey, setHasKey] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  // For AI tool execution, prefer an SSH session over the active tab (which
  // might be a local PTY like kimi/claude). Falls back to active if no SSH.
  const activeSession = (() => {
    const active = sessions.find((s) => s.sessionId === activeSessionId);
    if (active && active.config.protocol !== 'local' && active.connected) return active;
    // Find any connected SSH session
    const sshSession = sessions.find(
      (s) => s.config.protocol !== 'local' && s.connected
    );
    return sshSession || active;
  })();

  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [messages, isLoading]);

  // Track whether the selected provider has a key stored in the Rust key store.
  // Re-check on provider change AND when the Settings modal closes (a key may
  // have just been added there).
  const showSettings = useSessionStore((s) => s.showSettings);
  useEffect(() => {
    const provider = settings.aiProvider || 'ollama';
    invoke<boolean>('ai_has_key', { provider })
      .then(setHasKey)
      .catch(() => setHasKey(false));
  }, [settings.aiProvider, showSettings]);

  const sendMessage = useCallback(async (content: string) => {
    if (!content.trim() || isLoading) return;

    const userMsg: DisplayMessage = { role: 'user', content: content.trim(), timestamp: Date.now() };
    setMessages((prev) => [...prev, userMsg]);
    setInput('');
    setIsLoading(true);

    // The assistant talks to providers from the Rust backend. In a plain browser
    // tab there is no Tauri IPC, so fail with a clear message instead of a cryptic
    // "window.__TAURI_IPC__ is not a function".
    if (!('__TAURI_IPC__' in window)) {
      setMessages((prev) => [
        ...prev,
        {
          role: 'assistant',
          content:
            'The AI assistant runs through the desktop backend. Launch **Aruba Terminal Pro** (the installed app, or `npm run tauri dev`) — it can\'t reach AI providers or the terminal from a regular browser tab.',
          timestamp: Date.now(),
          isError: true,
        },
      ]);
      setIsLoading(false);
      return;
    }

    const provider: AiProvider = settings.aiProvider || 'ollama';
    const providerMeta = AI_PROVIDERS.find((p) => p.value === provider);

    // Guard: key-based providers need a key in the Rust key store. Query it
    // FRESH (not the cached `hasKey`) — adding a key in Settings doesn't trigger
    // a re-render here, so a stale cache would wrongly block sending.
    if (providerMeta?.needsKey) {
      const keyPresent = await invoke<boolean>('ai_has_key', { provider }).catch(() => false);
      setHasKey(keyPresent);
      if (!keyPresent) {
        setMessages((prev) => [
          ...prev,
          {
            role: 'assistant',
            content: `No API key configured for **${providerMeta.label}**. Open **Settings** (Ctrl+,) → AI Assistant and add your key, or switch provider.`,
            timestamp: Date.now(),
            isError: true,
          },
        ]);
        setIsLoading(false);
        return;
      }
    }

    // Build conversation history for the API (user/assistant only)
    const apiMessages: AnthropicMessage[] = [...messages, userMsg]
      .map((m) => ({ role: m.role as 'user' | 'assistant', content: m.content }));

    const deviceContext = buildDeviceContext(activeSession);
    const systemPrompt = SYSTEM_PROMPT(deviceContext, settings.aiReferences || '');
    const collectedTools: ToolExecution[] = [];

    try {
      let text = '';

      if (provider === 'anthropic') {
        text = await callAnthropicWithTools(
          apiMessages,
          settings.aiModel || 'claude-sonnet-4-6',
          systemPrompt,
          activeSession,
          (tool) => collectedTools.push(tool)
        );
      } else if (provider === 'local-cli') {
        text = await callLocalCli(
          settings.localCliCommand || 'claude -p',
          apiMessages,
          systemPrompt,
          activeSession
        );
      } else {
        // OpenAI-compatible: openrouter | moonshot | ollama — each has its own model.
        const model =
          provider === 'ollama'
            ? settings.ollamaModel || 'llama3.2'
            : provider === 'openrouter'
              ? settings.openrouterModel || 'anthropic/claude-3.5-sonnet'
              : settings.moonshotModel || 'kimi-k2-0905-preview';
        text = await callOpenAiCompatWithTools(
          provider,
          settings.ollamaUrl || 'http://localhost:11434',
          model,
          apiMessages,
          systemPrompt,
          activeSession,
          (tool) => collectedTools.push(tool)
        );
      }

      setMessages((prev) => [
        ...prev,
        {
          role: 'assistant',
          content: text,
          timestamp: Date.now(),
          toolExecutions: collectedTools.length > 0 ? [...collectedTools] : undefined,
        },
      ]);
    } catch (e: unknown) {
      const errMsg = e instanceof Error ? e.message : String(e);
      setMessages((prev) => [
        ...prev,
        {
          role: 'assistant',
          content: `**${provider === 'ollama' ? 'Ollama' : 'API'} Error:** ${errMsg}`,
          timestamp: Date.now(),
          isError: true,
        },
      ]);
    } finally {
      setIsLoading(false);
    }
  }, [messages, isLoading, settings, activeSession]);

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      sendMessage(input);
    }
  };

  const toggleTool = (idx: number) => {
    setExpandedTools((prev) => {
      const next = new Set(prev);
      if (next.has(idx)) next.delete(idx);
      else next.add(idx);
      return next;
    });
  };


  if (!showAiAssistant) return null;

  const provider = settings.aiProvider || 'ollama';
  const providerMeta = AI_PROVIDERS.find((p) => p.value === provider);
  const isLocalProvider = provider === 'ollama' || provider === 'local-cli';
  const isReady = !providerMeta?.needsKey || hasKey;
  const providerLabel =
    provider === 'ollama'
      ? settings.ollamaModel || 'llama3.2'
      : provider === 'local-cli'
        ? settings.localCliCommand || 'CLI'
        : provider === 'anthropic'
          ? settings.aiModel?.split('-').slice(1, 3).join(' ') || 'Claude'
          : settings.aiModel || providerMeta?.label || provider;

  return (
    <div
      className="flex-shrink-0 flex flex-col bg-[var(--bg-primary)] border-l border-[var(--bg-tertiary)] overflow-hidden relative"
      style={{ width: panelWidth }}
    >
      {/* Drag handle */}
      <div className={dragHandleClass} onMouseDown={handleDragStart} />

      {/* Header */}
      <div className="flex items-center justify-between h-10 px-3 pl-4 border-b border-[var(--bg-tertiary)] bg-[var(--bg-secondary)]">
        <div className="flex items-center gap-2">
          <Sparkles size={14} className="text-[#d2a8ff]" />
          <span className="text-xs font-semibold text-[var(--text-primary)] uppercase tracking-wider">
            AI Assistant
          </span>
          <span className={`text-[10px] px-1.5 py-0.5 rounded ${
            isLocalProvider
              ? 'text-[#56d4dd] bg-[#56d4dd15]'
              : 'text-[#3fb950] bg-[#3fb95015]'
          }`}>
            {isLocalProvider ? '⬡ ' : '✦ '}{providerLabel}
          </span>
        </div>
        <div className="flex items-center gap-1">
          <button
            onClick={() => useSessionStore.getState().setShowSettings(true)}
            className="p-1 rounded hover:bg-[var(--bg-tertiary)] text-[var(--text-secondary)] hover:text-[var(--text-primary)]"
            title="Settings"
          >
            <Settings size={13} />
          </button>
          <button
            onClick={toggleAiAssistant}
            className="p-1 rounded hover:bg-[var(--bg-tertiary)] text-[var(--text-secondary)] hover:text-[#ff7b72]"
            title="Close"
          >
            <X size={14} />
          </button>
        </div>
      </div>

      {/* Device context bar */}
      <div className="flex items-center gap-2 px-3 py-1.5 border-b border-[var(--bg-tertiary)] bg-[var(--bg-secondary)]">
        <Terminal size={11} className={activeSession?.connected ? 'text-[#3fb950]' : 'text-[var(--text-muted)]'} />
        {activeSession ? (
          <span className="text-[10px] text-[var(--text-secondary)]">
            <span className="text-[var(--text-primary)]">{activeSession.config.name}</span>
            <span className="mx-1 text-[var(--border)]">·</span>
            {activeSession.config.deviceType}
            <span className="mx-1 text-[var(--border)]">·</span>
            <span className={activeSession.connected ? 'text-[#3fb950]' : 'text-[var(--text-muted)]'}>
              {activeSession.connected ? 'connected' : 'disconnected'}
            </span>
          </span>
        ) : (
          <span className="text-[10px] text-[var(--text-muted)]">No active session</span>
        )}
      </div>

      {/* Warning when not ready */}
      {!isReady && (
        <div className="mx-3 mt-3 px-3 py-2 bg-[#d2991520] border border-[#d2991540] rounded-lg flex items-start gap-2">
          <AlertCircle size={12} className="text-[#d29922] flex-shrink-0 mt-0.5" />
          <div className="text-[10px] text-[#d29922] leading-relaxed">
            Add an API key for <strong>{providerMeta?.label}</strong> in <strong>Settings → AI Assistant</strong>, or switch to a local provider (Ollama / Local CLI).
          </div>
        </div>
      )}

      {/* Chat */}
      <div ref={scrollRef} className="flex-1 overflow-y-auto px-3 py-3 space-y-3">
        {/* Prebuilt prompts when chat is empty */}
        {messages.length === 0 && (
          <div className="space-y-1.5">
            <p className="text-[10px] text-[var(--text-muted)] mb-2">Quick actions:</p>
            {PREBUILT_PROMPTS.map((p) => (
              <button
                key={p.label}
                onClick={() => sendMessage(p.prompt)}
                disabled={isLoading}
                className="w-full flex items-center gap-2 px-3 py-2 text-xs text-left text-[var(--text-secondary)] hover:text-[var(--text-primary)] bg-[var(--bg-secondary)] hover:bg-[var(--bg-tertiary)] border border-[var(--border)] hover:border-[var(--text-muted)] rounded-lg transition-all disabled:opacity-50"
              >
                <ChevronRight size={10} className="text-[#d2a8ff]" />
                {p.label}
              </button>
            ))}
          </div>
        )}

        {/* Messages */}
        {messages.map((msg, i) => (
          <div key={i}>
            {msg.role === 'user' ? (
              <div className="flex items-start gap-2 flex-row-reverse">
                <div className="flex-shrink-0 w-6 h-6 rounded-full bg-[#58a6ff20] flex items-center justify-center">
                  <User size={12} className="text-[#58a6ff]" />
                </div>
                <div className="max-w-[88%] px-3 py-2 rounded-lg bg-[#58a6ff15] border border-[#58a6ff25] text-[var(--text-primary)]">
                  <p className="text-[11px] leading-relaxed whitespace-pre-wrap">{msg.content}</p>
                  <div className="text-[9px] text-[var(--text-muted)] mt-1 flex items-center gap-1 justify-end">
                    <Clock size={7} />
                    {new Date(msg.timestamp).toLocaleTimeString()}
                  </div>
                </div>
              </div>
            ) : (
              <div className="flex items-start gap-2">
                <div className={`flex-shrink-0 w-6 h-6 rounded-full flex items-center justify-center ${msg.isError ? 'bg-[#ff7b7220]' : 'bg-[#d2a8ff20]'}`}>
                  {msg.isError ? (
                    <AlertCircle size={12} className="text-[#ff7b72]" />
                  ) : (
                    <Bot size={12} className="text-[#d2a8ff]" />
                  )}
                </div>
                <div className="flex-1 min-w-0">
                  {/* Tool executions */}
                  {msg.toolExecutions && msg.toolExecutions.length > 0 && (
                    <div className="mb-2 space-y-1">
                      {msg.toolExecutions.map((te, ti) => (
                        <div key={ti} className="border border-[var(--border)] rounded-lg overflow-hidden">
                          <button
                            onClick={() => toggleTool(i * 100 + ti)}
                            className="w-full flex items-center gap-2 px-2.5 py-1.5 bg-[var(--bg-secondary)] hover:bg-[var(--bg-tertiary)] text-left transition-colors"
                          >
                            <Terminal size={10} className="text-[#58a6ff]" />
                            <code className="text-[10px] text-[#58a6ff] font-mono flex-1 truncate">
                              {(te.args.command as string) || te.name}
                            </code>
                            <CheckCircle2 size={9} className="text-[#3fb950] flex-shrink-0" />
                            {expandedTools.has(i * 100 + ti) ? (
                              <ChevronDown size={9} className="text-[var(--text-muted)]" />
                            ) : (
                              <ChevronRight size={9} className="text-[var(--text-muted)]" />
                            )}
                          </button>
                          {expandedTools.has(i * 100 + ti) && (
                            <div className="px-2.5 py-2 bg-[var(--bg-primary)] border-t border-[var(--border)]">
                              <p className="text-[10px] text-[var(--text-secondary)] font-mono">{te.result}</p>
                            </div>
                          )}
                        </div>
                      ))}
                    </div>
                  )}

                  {/* Message content */}
                  <div className={`px-3 py-2 rounded-lg ${msg.isError ? 'bg-[#ff7b7210] border border-[#ff7b7225] text-[#ff7b72]' : 'bg-[var(--bg-secondary)] border border-[var(--border)] text-[var(--text-primary)]'}`}>
                    <div className="space-y-0.5">{renderMarkdown(msg.content)}</div>
                    <div className="text-[9px] text-[var(--text-muted)] mt-1.5 flex items-center gap-1">
                      <Clock size={7} />
                      {new Date(msg.timestamp).toLocaleTimeString()}
                    </div>
                  </div>
                </div>
              </div>
            )}
          </div>
        ))}

        {/* Loading */}
        {isLoading && (
          <div className="flex items-center gap-2">
            <div className="w-6 h-6 rounded-full bg-[#d2a8ff20] flex items-center justify-center flex-shrink-0">
              <Bot size={12} className="text-[#d2a8ff]" />
            </div>
            <div className="flex items-center gap-1.5 px-3 py-2 bg-[var(--bg-secondary)] border border-[var(--border)] rounded-lg text-[11px] text-[var(--text-secondary)]">
              <Loader2 size={11} className="animate-spin text-[#d2a8ff]" />
              Thinking…
            </div>
          </div>
        )}
      </div>

      {/* Input */}
      <div className="px-3 py-2 border-t border-[var(--bg-tertiary)] bg-[var(--bg-secondary)]">
        <div className="flex items-end gap-2">
          <textarea
            ref={inputRef}
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder={isReady ? 'Ask about the device…' : 'Configure AI provider in Settings…'}
            rows={1}
            disabled={isLoading}
            className="flex-1 text-xs bg-[var(--bg-primary)] border border-[var(--border)] rounded-lg px-3 py-2 text-[var(--text-primary)] placeholder-[var(--text-muted)] focus:outline-none focus:border-[#58a6ff] resize-none max-h-28 disabled:opacity-50"
            style={{ minHeight: '36px' }}
          />
          <button
            type="button"
            onClick={() => sendMessage(input)}
            disabled={!input.trim() || isLoading}
            className="flex items-center justify-center w-9 h-9 bg-[#238636] hover:bg-[#2ea043] disabled:opacity-40 text-white rounded-lg transition-colors flex-shrink-0"
          >
            <Send size={14} />
          </button>
        </div>
        <p className="text-[9px] text-[var(--text-muted)] mt-1 text-center">
          Shift+Enter for new line · Commands execute on active device
        </p>
      </div>
    </div>
  );
}
