import { useState, useEffect } from 'react';
import { X, RotateCcw, Moon, Sun, Eye, EyeOff, CheckCircle2 } from 'lucide-react';
import { invoke } from '@tauri-apps/api/tauri';
import { useSessionStore } from '../store/sessionStore';
import { useSettingsStore } from '../store/settingsStore';
import { AI_PROVIDERS, AI_CLI_PRESETS } from '../types';

export default function SettingsPanel() {
  const { showSettings, setShowSettings } = useSessionStore();
  const settings = useSettingsStore();
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
              onClick={() => settings.resetToDefaults()}
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
                        ? 'bg-[var(--bg-tertiary)] border-[#58a6ff] text-[var(--text-primary)]'
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
                        ? 'bg-[#ffffff] border-[#58a6ff] text-[#1f2328]'
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
                    className="flex-1 accent-[#238636]"
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
                  className="w-full h-8 px-2 bg-[var(--bg-primary)] border border-[var(--border)] rounded-lg text-sm text-[var(--text-primary)] focus:outline-none focus:border-[#58a6ff]"
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
                            ? 'bg-[var(--bg-tertiary)] border-[#58a6ff] text-[var(--text-primary)]'
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
                    className="flex-1 accent-[#238636]"
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
                    className={`
                      w-9 h-5 rounded-full transition-colors cursor-pointer relative
                      ${value ? 'bg-[#238636]' : 'bg-[var(--border)]'}
                    `}
                  >
                    <div
                      className={`
                        absolute top-0.5 w-4 h-4 rounded-full bg-white shadow-sm transition-transform
                        ${value ? 'translate-x-4.5 left-0' : 'left-0.5'}
                      `}
                      style={{
                        transform: value ? 'translateX(16px)' : 'translateX(0)',
                      }}
                    />
                  </div>
                </label>
              ))}
            </div>
          </section>

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
                  className="flex-1 accent-[#238636]"
                />
                <span className="text-sm text-[var(--text-primary)] w-8 text-right">
                  {settings.keepAliveInterval}
                </span>
              </div>
            </div>
          </section>

          <div className="border-t border-[var(--bg-tertiary)]" />

          {/* AI */}
          <section>
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
                          ? 'bg-[var(--bg-tertiary)] border-[#58a6ff] text-[var(--text-primary)]'
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
                        <span className="flex items-center gap-1 text-[#3fb950]">
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
                          className="ml-auto text-[10px] text-[var(--text-muted)] hover:text-[#ff7b72]"
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
                      className="w-full h-8 px-2 pr-8 bg-[var(--bg-primary)] border border-[var(--border)] rounded-lg text-sm text-[var(--text-primary)] placeholder-[var(--text-muted)] focus:outline-none focus:border-[#58a6ff] font-mono"
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
                    className="w-full h-8 px-2 bg-[var(--bg-primary)] border border-[var(--border)] rounded-lg text-sm text-[var(--text-primary)] focus:outline-none focus:border-[#58a6ff]"
                  >
                    <option value="claude-sonnet-4-6">Claude Sonnet 4.6 (Recommended)</option>
                    <option value="claude-opus-4-7">Claude Opus 4.7 (Most capable)</option>
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
                    className="w-full h-8 px-2 bg-[var(--bg-primary)] border border-[var(--border)] rounded-lg text-sm text-[var(--text-primary)] placeholder-[var(--text-muted)] focus:outline-none focus:border-[#58a6ff] font-mono"
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
                    className="w-full h-8 px-2 bg-[var(--bg-primary)] border border-[var(--border)] rounded-lg text-sm text-[var(--text-primary)] placeholder-[var(--text-muted)] focus:outline-none focus:border-[#58a6ff] font-mono"
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
                            ? 'bg-[var(--bg-tertiary)] border-[#58a6ff] text-[var(--text-primary)]'
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
                    className="w-full h-8 px-2 bg-[var(--bg-primary)] border border-[var(--border)] rounded-lg text-sm text-[var(--text-primary)] placeholder-[var(--text-muted)] focus:outline-none focus:border-[#58a6ff] font-mono"
                  />
                  <p className="text-[10px] text-[var(--text-muted)] mt-1">
                    Runs a locally-installed CLI one-shot with the prompt on stdin — <span className="text-[#3fb950]">no API key needed</span> (the CLI uses its own login). E.g. <code className="text-[var(--text-primary)]">claude -p</code>, <code className="text-[var(--text-primary)]">kimi</code>, <code className="text-[var(--text-primary)]">copilot -p</code>.
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
                      className="w-full h-8 px-2 bg-[var(--bg-primary)] border border-[var(--border)] rounded-lg text-sm text-[var(--text-primary)] placeholder-[var(--text-muted)] focus:outline-none focus:border-[#58a6ff] font-mono"
                    />
                  </div>
                  <div>
                    <label className="block text-xs text-[var(--text-secondary)] mb-1.5">Model</label>
                    <input
                      type="text"
                      value={settings.ollamaModel}
                      onChange={(e) => settings.setOllamaModel(e.target.value)}
                      placeholder="llama3.2"
                      className="w-full h-8 px-2 bg-[var(--bg-primary)] border border-[var(--border)] rounded-lg text-sm text-[var(--text-primary)] placeholder-[var(--text-muted)] focus:outline-none focus:border-[#58a6ff] font-mono"
                    />
                    <p className="text-[10px] text-[var(--text-muted)] mt-1">
                      Run <code className="text-[var(--text-primary)]">ollama list</code> to see installed models. Recommended: llama3.2, mistral, codellama
                    </p>
                  </div>
                </>
              )}
            </div>
          </section>
        </div>
      </div>
    </div>
  );
}
