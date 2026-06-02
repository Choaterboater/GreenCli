import { useState, useEffect } from 'react';
import { X, RotateCcw, Moon, Sun, Eye, EyeOff, CheckCircle2 } from 'lucide-react';
import { invoke } from '@tauri-apps/api/tauri';
import { useSessionStore } from '../store/sessionStore';
import { useSettingsStore } from '../store/settingsStore';
import { askConfirm } from '../store/dialogStore';
import { AI_PROVIDERS, AI_CLI_PRESETS, TerminalSettings } from '../types';
import McpServers from './McpServers';
import AiAgents from './AiAgents';
import HostsManager from './HostsManager';
import TriggersSettings from './TriggersSettings';
import CentralSettings from './CentralSettings';

// Curated best-practices the AI should apply, distilled from Juniper Validated
// Designs (JVDs). Appended to the references field on request.
const JVD_REFERENCES = `# Juniper Validated Design (JVD) best-practices
- EVPN-VXLAN data center: eBGP IP-fabric underlay (lo0 reachability), eBGP EVPN
  overlay with family evpn signaling; prefer ERB (edge-routed bridging) with IRB
  anycast gateways; consistent route-targets/VNIs; MTU/jumbo on fabric links.
- AI/GPU (RoCEv2) fabric: lossless Ethernet — PFC on the RoCE priority + ECN
  marking (WRED), rail-optimized topology, no oversubscription on GPU-facing links;
  verify no tail drops / PFC pause storms.
- EVPN campus: collapsed/distributed EVPN, map VLANs to VNIs, ESI-LAG for
  multihoming, Mist Wired Assurance for SLE/health.
- WAN/SD-WAN: Mist WAN Assurance + application-aware routing; redundant edges.
- Verification (operational intent): underlay/overlay BGP all Established, EVPN
  routes present (bgp.evpn.0), VXLAN VTEPs up, no interface errors/drops.
- General: out-of-band mgmt, RFC5549 or lo0 /32s, config via Apstra where managed,
  golden config + commit confirmed.`;

export default function SettingsPanel() {
  const { showSettings, setShowSettings, settingsFocus, setSettingsFocus } = useSessionStore();
  const settings = useSettingsStore();

  // When opened via a Help deep-link, scroll the targeted section into view and
  // flash it so the user sees exactly which field to edit.
  useEffect(() => {
    if (!showSettings || !settingsFocus) return;
    const id = setTimeout(() => {
      const el = document.getElementById(`set-${settingsFocus}`);
      if (el) {
        el.scrollIntoView({ behavior: 'smooth', block: 'center' });
        el.classList.add('help-flash');
        setTimeout(() => el.classList.remove('help-flash'), 1600);
      }
      setSettingsFocus(null);
    }, 120);
    return () => clearTimeout(id);
  }, [showSettings, settingsFocus, setSettingsFocus]);
  const [showApiKey, setShowApiKey] = useState(false);
  const [keyInput, setKeyInput] = useState('');
  const [keySaved, setKeySaved] = useState(false);

  const aiProvider = settings.aiProvider;
  const providerMeta = AI_PROVIDERS.find((p) => p.value === aiProvider);

  // When the selected provider changes, reflect whether a key is already stored
  // (in the Rust key store) and reset the transient input.
  useEffect(() => {
    setKeyInput('');
    if (providerMeta?.needsKey) {
      invoke<boolean>('ai_has_key', { provider: aiProvider })
        .then(setKeySaved)
        .catch(() => setKeySaved(false));
    } else {
      setKeySaved(false);
    }
  }, [aiProvider, providerMeta?.needsKey]);

  const saveKey = () => {
    // Don't overwrite a stored key when the (always-empty-on-open) field is
    // blurred without typing — that would silently wipe a saved key.
    if (!keyInput) return;
    invoke('ai_set_key', { provider: aiProvider, key: keyInput })
      .then(() => setKeySaved(true))
      .catch(() => {});
  };

  if (!showSettings) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm">
      <div className="w-[520px] max-h-[80vh] bg-[var(--bg-secondary)] border border-[var(--border)] rounded-xl shadow-2xl flex flex-col">
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-4 border-b border-[var(--bg-tertiary)]">
          <h2 className="text-lg font-semibold text-[var(--text-primary)]">Settings</h2>
          <div className="flex items-center gap-2">
            <button
              onClick={async () => {
                const ok = await askConfirm({
                  title: 'Reset all settings?',
                  message:
                    'This clears every saved Central account, the Apstra config, AI references, and all tool toggles back to defaults. This cannot be undone.',
                  confirmLabel: 'Reset',
                  danger: true,
                });
                if (ok) settings.resetToDefaults();
              }}
              className="flex items-center gap-1.5 px-2.5 py-1.5 text-xs bg-[var(--bg-tertiary)] hover:bg-[var(--border)] text-[var(--text-secondary)] rounded-lg transition-colors"
            >
              <RotateCcw size={12} />
              Reset
            </button>
            <button
              onClick={() => setShowSettings(false)}
              className="p-1.5 rounded hover:bg-[var(--bg-tertiary)] text-[var(--text-secondary)] hover:text-[var(--text-primary)]"
            >
              <X size={16} />
            </button>
          </div>
        </div>

        {/* Content */}
        <div className="flex-1 overflow-y-auto px-5 py-4 space-y-5">
          {/* Appearance */}
          <section>
            <h3 className="text-sm font-semibold text-[var(--text-primary)] mb-3">
              Appearance
            </h3>

            {/* Theme */}
            <div className="mb-3">
              <label className="block text-xs text-[var(--text-secondary)] mb-1.5">
                Theme
              </label>
              <div className="flex gap-2">
                <button
                  onClick={() => settings.setTheme('dark')}
                  className={`
                    flex items-center gap-2 flex-1 py-2 rounded-lg border text-sm transition-colors
                    ${
                      settings.theme === 'dark'
                        ? 'bg-[var(--bg-tertiary)] border-[var(--accent)] text-[var(--text-primary)]'
                        : 'bg-[var(--bg-primary)] border-[var(--border)] text-[var(--text-secondary)] hover:border-[var(--text-muted)]'
                    }
                  `}
                >
                  <Moon size={14} />
                  Dark
                </button>
                <button
                  onClick={() => settings.setTheme('light')}
                  className={`
                    flex items-center gap-2 flex-1 py-2 rounded-lg border text-sm transition-colors
                    ${
                      settings.theme === 'light'
                        ? 'bg-[#ffffff] border-[var(--accent)] text-[#1f2328]'
                        : 'bg-[var(--bg-primary)] border-[var(--border)] text-[var(--text-secondary)] hover:border-[var(--text-muted)]'
                    }
                  `}
                >
                  <Sun size={14} />
                  Light
                </button>
              </div>
            </div>

            {/* Font */}
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="block text-xs text-[var(--text-secondary)] mb-1.5">
                  Font Size
                </label>
                <div className="flex items-center gap-2">
                  <input
                    type="range"
                    min={8}
                    max={24}
                    value={settings.fontSize}
                    onChange={(e) =>
                      settings.setFontSize(Number(e.target.value))
                    }
                    className="flex-1 accent-[var(--accent)]"
                  />
                  <span className="text-sm text-[var(--text-primary)] w-6 text-right">
                    {settings.fontSize}
                  </span>
                </div>
              </div>
              <div>
                <label className="block text-xs text-[var(--text-secondary)] mb-1.5">
                  Font Family
                </label>
                <select
                  value={settings.fontFamily}
                  onChange={(e) => settings.setFontFamily(e.target.value)}
                  className="w-full h-8 px-2 bg-[var(--bg-primary)] border border-[var(--border)] rounded-lg text-sm text-[var(--text-primary)] focus:outline-none focus:border-[var(--accent)]"
                >
                  <option value="JetBrains Mono, Consolas, monospace">
                    JetBrains Mono
                  </option>
                  <option value="Consolas, monospace">Consolas</option>
                  <option value="Fira Code, monospace">Fira Code</option>
                  <option value="Source Code Pro, monospace">
                    Source Code Pro
                  </option>
                  <option value="Courier New, monospace">Courier New</option>
                </select>
              </div>
            </div>
          </section>

          <div className="border-t border-[var(--bg-tertiary)]" />

          {/* Terminal Behavior */}
          <section>
            <h3 className="text-sm font-semibold text-[var(--text-primary)] mb-3">
              Terminal
            </h3>

            <div className="grid grid-cols-2 gap-3 mb-3">
              {/* Cursor Style */}
              <div>
                <label className="block text-xs text-[var(--text-secondary)] mb-1.5">
                  Cursor Style
                </label>
                <div className="flex gap-1">
                  {(['block', 'underline', 'bar'] as const).map((style) => (
                    <button
                      key={style}
                      onClick={() => settings.setCursorStyle(style)}
                      className={`
                        flex-1 py-1.5 text-xs rounded-md border capitalize transition-colors
                        ${
                          settings.cursorStyle === style
                            ? 'bg-[var(--bg-tertiary)] border-[var(--accent)] text-[var(--text-primary)]'
                            : 'bg-[var(--bg-primary)] border-[var(--border)] text-[var(--text-secondary)] hover:border-[var(--text-muted)]'
                        }
                      `}
                    >
                      {style}
                    </button>
                  ))}
                </div>
              </div>

              {/* Scrollback */}
              <div>
                <label className="block text-xs text-[var(--text-secondary)] mb-1.5">
                  Scrollback Lines
                </label>
                <div className="flex items-center gap-2">
                  <input
                    type="range"
                    min={1000}
                    max={50000}
                    step={1000}
                    value={settings.scrollback}
                    onChange={(e) =>
                      settings.setScrollback(Number(e.target.value))
                    }
                    className="flex-1 accent-[var(--accent)]"
                  />
                  <span className="text-xs text-[var(--text-primary)] w-12 text-right">
                    {settings.scrollback >= 1000
                      ? `${settings.scrollback / 1000}K`
                      : settings.scrollback}
                  </span>
                </div>
              </div>
            </div>

            {/* Toggles */}
            <div className="space-y-2">
              {[
                {
                  label: 'Cursor Blink',
                  value: settings.cursorBlink,
                  onChange: settings.setCursorBlink,
                },
                {
                  label: 'Bell',
                  value: settings.bell,
                  onChange: settings.setBell,
                },
                {
                  label: 'Word Wrap',
                  value: settings.wordWrap,
                  onChange: settings.setWordWrap,
                },
                {
                  label: 'Syntax Highlighting',
                  value: settings.syntaxHighlighting,
                  onChange: settings.setSyntaxHighlighting,
                },
                {
                  label: 'Auto Reconnect',
                  value: settings.autoReconnect,
                  onChange: settings.setAutoReconnect,
                },
              ].map(({ label, value, onChange }) => (
                <label
                  key={label}
                  className="flex items-center justify-between cursor-pointer py-1"
                >
                  <span className="text-sm text-[var(--text-primary)]">{label}</span>
                  <div
                    onClick={() => onChange(!value)}
                    className="w-9 h-5 rounded-full transition-colors cursor-pointer relative"
                    style={{ background: value ? 'var(--accent)' : 'var(--border-strong)' }}
                  >
                    <div
                      className="absolute top-0.5 left-0.5 w-4 h-4 rounded-full bg-white shadow-sm transition-transform"
                      style={{ transform: value ? 'translateX(16px)' : 'translateX(0)' }}
                    />
                  </div>
                </label>
              ))}
            </div>
          </section>

          <div className="border-t border-[var(--bg-tertiary)]" />

          {/* Output triggers */}
          <TriggersSettings />

          <div className="border-t border-[var(--bg-tertiary)]" />

          {/* Connection */}
          <section>
            <h3 className="text-sm font-semibold text-[var(--text-primary)] mb-3">
              Connection
            </h3>
            <div>
              <label className="block text-xs text-[var(--text-secondary)] mb-1.5">
                Keep-Alive Interval (seconds)
              </label>
              <div className="flex items-center gap-2">
                <input
                  type="range"
                  min={5}
                  max={120}
                  value={settings.keepAliveInterval}
                  onChange={(e) =>
                    settings.setKeepAliveInterval(Number(e.target.value))
                  }
                  className="flex-1 accent-[var(--accent)]"
                />
                <span className="text-sm text-[var(--text-primary)] w-8 text-right">
                  {settings.keepAliveInterval}
                </span>
              </div>
            </div>
          </section>

          <div className="border-t border-[var(--bg-tertiary)]" />

          {/* SSH config import + host-key management */}
          <HostsManager />

          <div className="border-t border-[var(--bg-tertiary)]" />

          {/* AI */}
          <section id="set-ai">
            <h3 className="text-sm font-semibold text-[var(--text-primary)] mb-3">
              AI Assistant
            </h3>
            <div className="space-y-3">
              {/* Provider selector */}
              <div>
                <label className="block text-xs text-[var(--text-secondary)] mb-1.5">Provider</label>
                <div className="grid grid-cols-3 gap-2">
                  {AI_PROVIDERS.map((p) => (
                    <button
                      key={p.value}
                      onClick={() => settings.setAiProvider(p.value)}
                      className={`py-2 text-[11px] rounded-lg border transition-colors ${
                        settings.aiProvider === p.value
                          ? 'bg-[var(--bg-tertiary)] border-[var(--accent)] text-[var(--text-primary)]'
                          : 'bg-[var(--bg-primary)] border-[var(--border)] text-[var(--text-secondary)] hover:border-[var(--text-muted)]'
                      }`}
                    >
                      {p.label}
                    </button>
                  ))}
                </div>
              </div>

              {/* Key-based providers: API key (stored in Rust, never in localStorage) */}
              {providerMeta?.needsKey && (
                <div>
                  <label className="block text-xs text-[var(--text-secondary)] mb-1.5 flex items-center gap-1.5">
                    API Key
                    {keySaved && (
                      <>
                        <span className="flex items-center gap-1 text-[var(--accent-success)]">
                          <CheckCircle2 size={11} /> saved
                        </span>
                        <button
                          type="button"
                          onClick={() => {
                            invoke('ai_set_key', { provider: aiProvider, key: '' })
                              .then(() => {
                                setKeySaved(false);
                                setKeyInput('');
                              })
                              .catch(() => {});
                          }}
                          className="ml-auto text-[10px] text-[var(--text-muted)] hover:text-[var(--accent-danger)]"
                        >
                          remove
                        </button>
                      </>
                    )}
                  </label>
                  <div className="relative">
                    <input
                      type={showApiKey ? 'text' : 'password'}
                      value={keyInput}
                      onChange={(e) => setKeyInput(e.target.value)}
                      onBlur={saveKey}
                      placeholder={keySaved ? '•••••••• (saved — type to replace)' : 'Enter API key'}
                      className="w-full h-8 px-2 pr-8 bg-[var(--bg-primary)] border border-[var(--border)] rounded-lg text-sm text-[var(--text-primary)] placeholder-[var(--text-muted)] focus:outline-none focus:border-[var(--accent)] font-mono"
                    />
                    <button
                      type="button"
                      onClick={() => setShowApiKey(!showApiKey)}
                      className="absolute right-2 top-1/2 -translate-y-1/2 text-[var(--text-muted)] hover:text-[var(--text-secondary)]"
                    >
                      {showApiKey ? <EyeOff size={12} /> : <Eye size={12} />}
                    </button>
                  </div>
                  <p className="text-[10px] text-[var(--text-muted)] mt-1">
                    Stored in the app data dir (outside the browser), sent only to the provider from the Rust backend.
                  </p>
                </div>
              )}

              {/* Model for key-based providers */}
              {providerMeta?.needsKey && aiProvider === 'anthropic' && (
                <div>
                  <label className="block text-xs text-[var(--text-secondary)] mb-1.5">Model</label>
                  <select
                    value={settings.aiModel}
                    onChange={(e) => settings.setAiModel(e.target.value)}
                    className="w-full h-8 px-2 bg-[var(--bg-primary)] border border-[var(--border)] rounded-lg text-sm text-[var(--text-primary)] focus:outline-none focus:border-[var(--accent)]"
                  >
                    <option value="claude-sonnet-4-6">Claude Sonnet 4.6 (Recommended)</option>
                    <option value="claude-opus-4-8">Claude Opus 4.8 (Most capable)</option>
                    <option value="claude-haiku-4-5-20251001">Claude Haiku 4.5 (Fastest)</option>
                  </select>
                </div>
              )}
              {aiProvider === 'openrouter' && (
                <div>
                  <label className="block text-xs text-[var(--text-secondary)] mb-1.5">Model</label>
                  <input
                    type="text"
                    value={settings.openrouterModel}
                    onChange={(e) => settings.setOpenrouterModel(e.target.value)}
                    placeholder="e.g. anthropic/claude-3.5-sonnet"
                    className="w-full h-8 px-2 bg-[var(--bg-primary)] border border-[var(--border)] rounded-lg text-sm text-[var(--text-primary)] placeholder-[var(--text-muted)] focus:outline-none focus:border-[var(--accent)] font-mono"
                  />
                  <p className="text-[10px] text-[var(--text-muted)] mt-1">
                    Any OpenRouter model id (see openrouter.ai/models), e.g. <code className="text-[var(--text-primary)]">openai/gpt-4o</code>, <code className="text-[var(--text-primary)]">meta-llama/llama-3.1-70b-instruct</code>.
                  </p>
                </div>
              )}
              {aiProvider === 'moonshot' && (
                <div>
                  <label className="block text-xs text-[var(--text-secondary)] mb-1.5">Model</label>
                  <input
                    type="text"
                    value={settings.moonshotModel}
                    onChange={(e) => settings.setMoonshotModel(e.target.value)}
                    placeholder="e.g. kimi-k2-0905-preview"
                    className="w-full h-8 px-2 bg-[var(--bg-primary)] border border-[var(--border)] rounded-lg text-sm text-[var(--text-primary)] placeholder-[var(--text-muted)] focus:outline-none focus:border-[var(--accent)] font-mono"
                  />
                  <p className="text-[10px] text-[var(--text-muted)] mt-1">
                    A Moonshot/Kimi model id (see platform.moonshot.ai), e.g. <code className="text-[var(--text-primary)]">moonshot-v1-8k</code>.
                  </p>
                </div>
              )}

              {/* Local CLI settings — no API key; the CLI handles its own login */}
              {aiProvider === 'local-cli' && (
                <div>
                  <label className="block text-xs text-[var(--text-secondary)] mb-1.5">CLI Command</label>
                  <div className="flex gap-2 mb-2">
                    {AI_CLI_PRESETS.map((p) => (
                      <button
                        key={p.label}
                        onClick={() => settings.setLocalCliCommand(p.command)}
                        className={`flex-1 py-1.5 text-[11px] rounded-lg border transition-colors ${
                          settings.localCliCommand === p.command
                            ? 'bg-[var(--bg-tertiary)] border-[var(--accent)] text-[var(--text-primary)]'
                            : 'bg-[var(--bg-primary)] border-[var(--border)] text-[var(--text-secondary)] hover:border-[var(--text-muted)]'
                        }`}
                      >
                        {p.label}
                      </button>
                    ))}
                  </div>
                  <input
                    type="text"
                    value={settings.localCliCommand}
                    onChange={(e) => settings.setLocalCliCommand(e.target.value)}
                    placeholder="claude -p"
                    className="w-full h-8 px-2 bg-[var(--bg-primary)] border border-[var(--border)] rounded-lg text-sm text-[var(--text-primary)] placeholder-[var(--text-muted)] focus:outline-none focus:border-[var(--accent)] font-mono"
                  />
                  <p className="text-[10px] text-[var(--text-muted)] mt-1">
                    Runs a locally-installed CLI one-shot with the prompt on stdin — <span className="text-[var(--accent-success)]">no API key needed</span> (the CLI uses its own login). E.g. <code className="text-[var(--text-primary)]">claude -p</code>, <code className="text-[var(--text-primary)]">kimi</code>, <code className="text-[var(--text-primary)]">copilot -p</code>.
                  </p>
                </div>
              )}

              {/* Ollama settings */}
              {settings.aiProvider === 'ollama' && (
                <>
                  <div>
                    <label className="block text-xs text-[var(--text-secondary)] mb-1.5">Ollama URL</label>
                    <input
                      type="text"
                      value={settings.ollamaUrl}
                      onChange={(e) => settings.setOllamaUrl(e.target.value)}
                      placeholder="http://localhost:11434"
                      className="w-full h-8 px-2 bg-[var(--bg-primary)] border border-[var(--border)] rounded-lg text-sm text-[var(--text-primary)] placeholder-[var(--text-muted)] focus:outline-none focus:border-[var(--accent)] font-mono"
                    />
                  </div>
                  <div>
                    <label className="block text-xs text-[var(--text-secondary)] mb-1.5">Model</label>
                    <input
                      type="text"
                      value={settings.ollamaModel}
                      onChange={(e) => settings.setOllamaModel(e.target.value)}
                      placeholder="llama3.2"
                      className="w-full h-8 px-2 bg-[var(--bg-primary)] border border-[var(--border)] rounded-lg text-sm text-[var(--text-primary)] placeholder-[var(--text-muted)] focus:outline-none focus:border-[var(--accent)] font-mono"
                    />
                    <p className="text-[10px] text-[var(--text-muted)] mt-1">
                      Run <code className="text-[var(--text-primary)]">ollama list</code> to see installed models. Recommended: llama3.2, mistral, codellama
                    </p>
                  </div>
                </>
              )}

              {/* Tool sources the assistant may use (opt-in beyond plain CLI) */}
              <div>
                <label className="block text-xs text-[var(--text-secondary)] mb-1.5">
                  Assistant tools <span className="text-[var(--text-muted)]">(opt-in)</span>
                </label>
                <div className="space-y-2.5 rounded-[var(--radius)] border border-[var(--border)] bg-[var(--bg-inset)] p-2.5">
                  {(
                    [
                      { key: 'aiUseTerminal', label: 'Run device CLI commands', hint: 'Execute show/config on the active SSH/terminal session' },
                      { key: 'aiUseCxRest', label: 'Aruba device REST APIs', hint: 'On-box REST for CX / AOS-S / AOS-8 — structured data, no Central' },
                      { key: 'aiUseMcp', label: 'MCP server tools', hint: 'Tools from connected MCP servers (centralmcp, etc.)' },
                      { key: 'aiUseApstra', label: 'Juniper Apstra', hint: 'Query the configured Apstra fabric controller (AOS REST)' },
                    ] as const
                  ).map(({ key, label, hint }) => {
                    const val = settings[key] as boolean;
                    return (
                      <label key={key} className="flex items-center justify-between cursor-pointer gap-3">
                        <span className="min-w-0">
                          <span className="text-sm text-[var(--text-primary)]">{label}</span>
                          <span className="block text-[10px] text-[var(--text-muted)] truncate">{hint}</span>
                        </span>
                        <div
                          onClick={() => settings.updateSettings({ [key]: !val } as Partial<TerminalSettings>)}
                          className="w-9 h-5 rounded-full relative cursor-pointer transition-colors flex-shrink-0"
                          style={{ background: val ? 'var(--accent)' : 'var(--border-strong)' }}
                        >
                          <div
                            className="absolute top-0.5 left-0.5 w-4 h-4 rounded-full bg-white transition-transform"
                            style={{ transform: val ? 'translateX(16px)' : 'translateX(0)' }}
                          />
                        </div>
                      </label>
                    );
                  })}
                </div>
              </div>

              {/* References / standards — lightweight grounding for the AI */}
              <div>
                <div className="flex items-center justify-between mb-1.5">
                  <label className="block text-xs text-[var(--text-secondary)]">
                    Best-practice references / standards
                  </label>
                  <button
                    onClick={() => {
                      if (settings.aiReferences.includes('Juniper Validated Design')) return;
                      const cur = settings.aiReferences.trimEnd();
                      settings.setAiReferences((cur ? cur + '\n\n' : '') + JVD_REFERENCES);
                    }}
                    className="text-[10px] px-2 py-0.5 rounded bg-[var(--bg-tertiary)] hover:bg-[var(--border-strong)] text-[var(--text-secondary)] hover:text-[var(--text-primary)]"
                    title="Append Juniper Validated Design best-practices"
                  >
                    + JVD best-practices
                  </button>
                </div>
                <textarea
                  value={settings.aiReferences}
                  onChange={(e) => settings.setAiReferences(e.target.value)}
                  rows={6}
                  placeholder="Add your org standards, golden-config rules, or doc links the AI should apply…"
                  className="w-full px-2 py-1.5 bg-[var(--bg-primary)] border border-[var(--border)] rounded-lg text-xs text-[var(--text-primary)] placeholder-[var(--text-muted)] focus:outline-none focus:border-[var(--accent)] font-mono resize-y"
                />
                <p className="text-[10px] text-[var(--text-muted)] mt-1">
                  Injected into the AI's context (used by the Best-practices audit). Lightweight
                  alternative to RAG — paste rules or links here; a hosted RAG endpoint can feed
                  this same field later.
                </p>
              </div>
            </div>
          </section>

          <div className="border-t border-[var(--bg-tertiary)]" />

          {/* AI agents (per-session personas) */}
          <AiAgents />

          <div className="border-t border-[var(--bg-tertiary)]" />

          {/* MCP servers (external tools for the AI) */}
          <div id="set-mcp">
            <McpServers />
          </div>

          <div className="border-t border-[var(--bg-tertiary)]" />

          {/* Aruba Central (cloud API) — multi-account + token */}
          <div id="set-central">
            <CentralSettings />
          </div>

          <div className="border-t border-[var(--bg-tertiary)]" />

          {/* Juniper Apstra (DC fabric) */}
          <section id="set-apstra">
            <h3 className="text-sm font-semibold text-[var(--text-primary)] mb-3">Juniper Apstra</h3>
            <div className="space-y-3">
              <div>
                <label className="block text-xs text-[var(--text-secondary)] mb-1.5">Controller host / URL</label>
                <input
                  value={settings.apstraHost}
                  onChange={(e) => settings.updateSettings({ apstraHost: e.target.value })}
                  placeholder="apstra.example.com  (or https://apstra:443)"
                  className="input-field w-full h-8 px-2 text-sm font-mono"
                />
              </div>
              <div className="grid grid-cols-2 gap-2">
                <div>
                  <label className="block text-xs text-[var(--text-secondary)] mb-1.5">Username</label>
                  <input
                    value={settings.apstraUsername}
                    onChange={(e) => settings.updateSettings({ apstraUsername: e.target.value })}
                    placeholder="admin"
                    className="input-field w-full h-8 px-2 text-sm font-mono"
                  />
                </div>
                <div>
                  <label className="block text-xs text-[var(--text-secondary)] mb-1.5">Password</label>
                  <input
                    type="password"
                    value={settings.apstraPassword}
                    onChange={(e) => settings.updateSettings({ apstraPassword: e.target.value })}
                    placeholder="password"
                    className="input-field w-full h-8 px-2 text-sm font-mono"
                  />
                </div>
              </div>
              <p className="text-[10px] text-[var(--text-muted)]">
                Intent-based DC fabric (AOS REST). Token auth with auto-refresh. Enable
                <strong> Assistant tools → Juniper Apstra</strong> to let the AI query blueprints, systems, and anomalies.
              </p>
            </div>
          </section>

          {/* Juniper Mist (cloud) */}
          <section id="set-mist">
            <h3 className="text-sm font-semibold text-[var(--text-primary)] mb-3">Juniper Mist</h3>
            <div className="space-y-3">
              <div>
                <label className="block text-xs text-[var(--text-secondary)] mb-1.5">API base (region)</label>
                <input
                  value={settings.mistBaseUrl}
                  onChange={(e) => settings.updateSettings({ mistBaseUrl: e.target.value })}
                  placeholder="https://api.mist.com  (or api.eu.mist.com, api.gc1.mist.com …)"
                  className="input-field w-full h-8 px-2 text-sm font-mono"
                />
              </div>
              <div>
                <label className="block text-xs text-[var(--text-secondary)] mb-1.5">API token</label>
                <input
                  type="password"
                  value={settings.mistToken}
                  onChange={(e) => settings.updateSettings({ mistToken: e.target.value })}
                  placeholder="Mist API token"
                  className="input-field w-full h-8 px-2 text-sm font-mono"
                />
              </div>
              <p className="text-[10px] text-[var(--text-muted)]">
                Mist cloud REST (token auth). Create a token in the Mist portal (My Account → API Tokens).
                Use it from the <strong>API Explorer → Mist</strong> target.
              </p>
            </div>
          </section>

          {/* Device REST security */}
          <section id="set-tls">
            <h3 className="text-sm font-semibold text-[var(--text-primary)] mb-3">Device REST security</h3>
            <label className="flex items-center justify-between cursor-pointer gap-3">
              <span className="min-w-0">
                <span className="text-sm text-[var(--text-primary)]">Verify device TLS certificates</span>
                <span className="block text-[10px] text-[var(--text-muted)]">
                  Reject untrusted/self-signed certs on AOS-CX / AOS-8 / AOS-S / Apstra REST. Most
                  field gear ships a self-signed cert, so this is off by default — turn it on to
                  enforce verification.
                </span>
              </span>
              <div
                onClick={() => settings.updateSettings({ verifyDeviceTls: !settings.verifyDeviceTls })}
                className="w-9 h-5 rounded-full relative cursor-pointer transition-colors flex-shrink-0"
                style={{ background: settings.verifyDeviceTls ? 'var(--accent)' : 'var(--border-strong)' }}
              >
                <div
                  className="absolute top-0.5 left-0.5 w-4 h-4 rounded-full bg-white transition-transform"
                  style={{ transform: settings.verifyDeviceTls ? 'translateX(16px)' : 'translateX(0)' }}
                />
              </div>
            </label>
          </section>
        </div>
      </div>
    </div>
  );
}
