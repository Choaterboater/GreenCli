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

const SYSTEM_PROMPT = (deviceContext: string) => `You are Aruba AI, an expert network engineering assistant specializing in Aruba Networks equipment. You help network engineers configure, troubleshoot, and automate Aruba CX switches, Aruba Instant APs, and Aruba Mobility Controllers.

${deviceContext}

${ARUBA_KNOWLEDGE}

## Guidelines
- Be concise and technical — your users are network engineers
- When sending CLI commands, send one at a time and explain what each reveals
- For configuration changes, always confirm with the user before executing — ask "Shall I apply this?"
- Format configs in code blocks for easy copying to the Config Editor panel
- When you don't have live device data, say so clearly and suggest the commands to run
- You can execute show commands freely; be cautious with config changes`;

// ─── Prebuilt prompts ───

const PREBUILT_PROMPTS = [
  { label: 'Interface status', prompt: 'Show me all interfaces — which are up/down, speeds, and descriptions.' },
  { label: 'VLAN config', prompt: 'Show the current VLAN configuration including names and port assignments.' },
  { label: 'Troubleshoot connectivity', prompt: 'Walk me through troubleshooting a connectivity issue step by step. Run diagnostic commands on the device.' },
  { label: 'BGP / routing status', prompt: 'Check the routing table and BGP/OSPF neighbor status if configured.' },
];

// ─── Tool definitions ───

const TOOLS = [
  {
    name: 'send_terminal_command',
    description: 'Execute a CLI command on the currently connected Aruba device terminal. Output appears in the terminal window. Use for show commands to gather information. Always ask before running config-changing commands.',
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
      await invoke('send_data', {
        sessionId: activeSession.sessionId,
        data: command + '\r',
      });
      return `Sent command: \`${command}\` — output is now visible in the terminal window.`;
    } catch (e) {
      return `Failed to send command: ${e}`;
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

// ─── Local CLI passthrough (no tool loop — one-shot prompt) ───

async function callLocalCli(
  command: string,
  conversationHistory: AnthropicMessage[],
  systemPrompt: string
): Promise<string> {
  const transcript = conversationHistory
    .map((m) => {
      const text =
        typeof m.content === 'string'
          ? m.content
          : (m.content as AnthropicContentBlock[])
              .filter((b): b is AnthropicTextBlock => b.type === 'text')
              .map((b) => b.text)
              .join('\n');
      return `${m.role.toUpperCase()}: ${text}`;
    })
    .join('\n\n');
  const prompt = `${systemPrompt}\n\n${transcript}`;
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
        <pre key={key++} className="my-2 p-3 bg-[#0d1117] border border-[#30363d] rounded-lg overflow-x-auto">
          <code className="text-[11px] text-[#c9d1d9] font-mono whitespace-pre">
            {codeLines.join('\n')}
          </code>
        </pre>
      );
      i++;
      continue;
    }

    // Heading
    if (line.startsWith('## ')) {
      result.push(<h4 key={key++} className="text-xs font-bold text-[#c9d1d9] mt-2 mb-1">{line.slice(3)}</h4>);
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
      result.push(<hr key={key++} className="border-[#30363d] my-2" />);
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
      parts.push(<code key={k++} className="px-1 py-0.5 bg-[#0d1117] border border-[#30363d] rounded text-[#d29922] text-[10px] font-mono">{tok.slice(1, -1)}</code>);
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

  const [panelWidth, setPanelWidth] = useState(420);
  const [isDragging, setIsDragging] = useState(false);
  const dragStartX = useRef(0);
  const dragStartWidth = useRef(0);

  const [messages, setMessages] = useState<DisplayMessage[]>([]);
  const [input, setInput] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const [expandedTools, setExpandedTools] = useState<Set<number>>(new Set());
  const [hasKey, setHasKey] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  const activeSession = sessions.find((s) => s.sessionId === activeSessionId);

  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [messages, isLoading]);

  // Track whether the selected provider has a key stored in the Rust key store.
  useEffect(() => {
    const provider = settings.aiProvider || 'ollama';
    invoke<boolean>('ai_has_key', { provider })
      .then(setHasKey)
      .catch(() => setHasKey(false));
  }, [settings.aiProvider]);

  const sendMessage = useCallback(async (content: string) => {
    if (!content.trim() || isLoading) return;

    const userMsg: DisplayMessage = { role: 'user', content: content.trim(), timestamp: Date.now() };
    setMessages((prev) => [...prev, userMsg]);
    setInput('');
    setIsLoading(true);

    const provider: AiProvider = settings.aiProvider || 'ollama';
    const providerMeta = AI_PROVIDERS.find((p) => p.value === provider);

    // Guard: key-based providers need a key stored in the Rust key store.
    if (providerMeta?.needsKey && !hasKey) {
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

    // Build conversation history for the API (user/assistant only)
    const apiMessages: AnthropicMessage[] = [...messages, userMsg]
      .map((m) => ({ role: m.role as 'user' | 'assistant', content: m.content }));

    const deviceContext = buildDeviceContext(activeSession);
    const systemPrompt = SYSTEM_PROMPT(deviceContext);
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
          systemPrompt
        );
      } else {
        // OpenAI-compatible: openrouter | moonshot | ollama
        const model =
          provider === 'ollama'
            ? settings.ollamaModel || 'llama3.2'
            : settings.aiModel || 'anthropic/claude-3.5-sonnet';
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

  // Drag resize
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
      setPanelWidth(Math.max(300, Math.min(800, dragStartWidth.current + delta)));
    };
    const up = () => setIsDragging(false);
    window.addEventListener('mousemove', move);
    window.addEventListener('mouseup', up);
    return () => {
      window.removeEventListener('mousemove', move);
      window.removeEventListener('mouseup', up);
    };
  }, [isDragging]);

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
        <div className="flex items-center gap-2">
          <Sparkles size={14} className="text-[#d2a8ff]" />
          <span className="text-xs font-semibold text-[#c9d1d9] uppercase tracking-wider">
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
            className="p-1 rounded hover:bg-[#21262d] text-[#8b949e] hover:text-[#c9d1d9]"
            title="Settings"
          >
            <Settings size={13} />
          </button>
          <button
            onClick={toggleAiAssistant}
            className="p-1 rounded hover:bg-[#21262d] text-[#8b949e] hover:text-[#ff7b72]"
            title="Close"
          >
            <X size={14} />
          </button>
        </div>
      </div>

      {/* Device context bar */}
      <div className="flex items-center gap-2 px-3 py-1.5 border-b border-[#21262d] bg-[#161b22]">
        <Terminal size={11} className={activeSession?.connected ? 'text-[#3fb950]' : 'text-[#484f58]'} />
        {activeSession ? (
          <span className="text-[10px] text-[#8b949e]">
            <span className="text-[#c9d1d9]">{activeSession.config.name}</span>
            <span className="mx-1 text-[#30363d]">·</span>
            {activeSession.config.deviceType}
            <span className="mx-1 text-[#30363d]">·</span>
            <span className={activeSession.connected ? 'text-[#3fb950]' : 'text-[#484f58]'}>
              {activeSession.connected ? 'connected' : 'disconnected'}
            </span>
          </span>
        ) : (
          <span className="text-[10px] text-[#484f58]">No active session</span>
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
            <p className="text-[10px] text-[#484f58] mb-2">Quick actions:</p>
            {PREBUILT_PROMPTS.map((p) => (
              <button
                key={p.label}
                onClick={() => sendMessage(p.prompt)}
                disabled={isLoading}
                className="w-full flex items-center gap-2 px-3 py-2 text-xs text-left text-[#8b949e] hover:text-[#c9d1d9] bg-[#161b22] hover:bg-[#21262d] border border-[#30363d] hover:border-[#484f58] rounded-lg transition-all disabled:opacity-50"
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
                <div className="max-w-[88%] px-3 py-2 rounded-lg bg-[#58a6ff15] border border-[#58a6ff25] text-[#c9d1d9]">
                  <p className="text-[11px] leading-relaxed whitespace-pre-wrap">{msg.content}</p>
                  <div className="text-[9px] text-[#484f58] mt-1 flex items-center gap-1 justify-end">
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
                        <div key={ti} className="border border-[#30363d] rounded-lg overflow-hidden">
                          <button
                            onClick={() => toggleTool(i * 100 + ti)}
                            className="w-full flex items-center gap-2 px-2.5 py-1.5 bg-[#161b22] hover:bg-[#21262d] text-left transition-colors"
                          >
                            <Terminal size={10} className="text-[#58a6ff]" />
                            <code className="text-[10px] text-[#58a6ff] font-mono flex-1 truncate">
                              {(te.args.command as string) || te.name}
                            </code>
                            <CheckCircle2 size={9} className="text-[#3fb950] flex-shrink-0" />
                            {expandedTools.has(i * 100 + ti) ? (
                              <ChevronDown size={9} className="text-[#484f58]" />
                            ) : (
                              <ChevronRight size={9} className="text-[#484f58]" />
                            )}
                          </button>
                          {expandedTools.has(i * 100 + ti) && (
                            <div className="px-2.5 py-2 bg-[#0d1117] border-t border-[#30363d]">
                              <p className="text-[10px] text-[#8b949e] font-mono">{te.result}</p>
                            </div>
                          )}
                        </div>
                      ))}
                    </div>
                  )}

                  {/* Message content */}
                  <div className={`px-3 py-2 rounded-lg ${msg.isError ? 'bg-[#ff7b7210] border border-[#ff7b7225] text-[#ff7b72]' : 'bg-[#161b22] border border-[#30363d] text-[#c9d1d9]'}`}>
                    <div className="space-y-0.5">{renderMarkdown(msg.content)}</div>
                    <div className="text-[9px] text-[#484f58] mt-1.5 flex items-center gap-1">
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
            <div className="flex items-center gap-1.5 px-3 py-2 bg-[#161b22] border border-[#30363d] rounded-lg text-[11px] text-[#8b949e]">
              <Loader2 size={11} className="animate-spin text-[#d2a8ff]" />
              Thinking…
            </div>
          </div>
        )}
      </div>

      {/* Input */}
      <div className="px-3 py-2 border-t border-[#21262d] bg-[#161b22]">
        <div className="flex items-end gap-2">
          <textarea
            ref={inputRef}
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder={isReady ? 'Ask about the device…' : 'Configure AI provider in Settings…'}
            rows={1}
            disabled={isLoading}
            className="flex-1 text-xs bg-[#0d1117] border border-[#30363d] rounded-lg px-3 py-2 text-[#c9d1d9] placeholder-[#484f58] focus:outline-none focus:border-[#58a6ff] resize-none max-h-28 disabled:opacity-50"
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
        <p className="text-[9px] text-[#484f58] mt-1 text-center">
          Shift+Enter for new line · Commands execute on active device
        </p>
      </div>
    </div>
  );
}
