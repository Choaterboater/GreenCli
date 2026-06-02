import { useState } from 'react';
import { Bot, Plus, Trash2, ChevronDown, ChevronRight } from 'lucide-react';
import { useSettingsStore } from '../store/settingsStore';
import { AI_PROVIDERS, AI_CLI_PRESETS, AiProvider } from '../types';
import { generateId } from '../utils';

// Chip/swatch palette for agents — kept small so the sidebar chips stay legible.
const AGENT_COLORS = ['#22C55E', '#3B82F6', '#F59E0B', '#EF4444', '#A855F7', '#06B6D4', '#EC4899', '#84CC16'];

// Known models per provider so the agent editor offers a real picker instead of a
// blank text box (mirrors what the main AI settings expose).
const ANTHROPIC_MODELS = [
  { value: 'claude-sonnet-4-6', label: 'Claude Sonnet 4.6 (Recommended)' },
  { value: 'claude-opus-4-8', label: 'Claude Opus 4.8 (Most capable)' },
  { value: 'claude-haiku-4-5-20251001', label: 'Claude Haiku 4.5 (Fastest)' },
];
const MOONSHOT_MODELS = ['kimi-k2-0905-preview', 'moonshot-v1-8k', 'moonshot-v1-32k', 'moonshot-v1-128k'];
const OLLAMA_COMMON = ['llama3.2', 'llama3.1', 'mistral', 'codellama', 'qwen2.5-coder', 'phi3'];
const OPENROUTER_COMMON = [
  'anthropic/claude-3.5-sonnet',
  'openai/gpt-4o',
  'meta-llama/llama-3.1-70b-instruct',
  'google/gemini-flash-1.5',
];

function providerLabel(provider?: AiProvider | ''): string | null {
  if (!provider) return null;
  return AI_PROVIDERS.find((p) => p.value === provider)?.label ?? provider;
}

/**
 * Manage saved AI agent personas. Each agent bundles instructions + an optional
 * provider/model override; users attach one to a session from the sidebar so
 * different sessions get different assistants.
 */
export default function AiAgents() {
  const agents = useSettingsStore((s) => s.aiAgents) ?? [];
  const addAiAgent = useSettingsStore((s) => s.addAiAgent);
  const updateAiAgent = useSettingsStore((s) => s.updateAiAgent);
  const removeAiAgent = useSettingsStore((s) => s.removeAiAgent);
  const [openId, setOpenId] = useState<string | null>(null);

  const createAgent = () => {
    const id = `agent-${generateId()}`;
    addAiAgent({
      id,
      name: 'New agent',
      instructions: '',
      color: AGENT_COLORS[agents.length % AGENT_COLORS.length],
    });
    setOpenId(id);
  };

  return (
    <section id="set-agents">
      <div className="flex items-center justify-between mb-2">
        <h3 className="text-sm font-semibold text-[var(--text-primary)] flex items-center gap-1.5">
          <Bot size={15} className="text-[var(--accent)]" /> AI Agents
        </h3>
        <button
          onClick={createAgent}
          className="flex items-center gap-1 text-[11px] px-2 py-1 rounded-md bg-[var(--bg-tertiary)] hover:bg-[var(--border-strong)] text-[var(--text-secondary)] hover:text-[var(--text-primary)]"
        >
          <Plus size={12} /> New agent
        </button>
      </div>
      <p className="text-[11px] text-[var(--text-muted)] mb-3">
        Saved personas you can attach to a session from the sidebar (right-click a host →{' '}
        <span className="text-[var(--text-secondary)]">Agent</span>). The agent's instructions are added to
        the AI's system prompt for that session, and any provider/model override replaces the defaults.
      </p>

      <div className="space-y-2">
        {agents.length === 0 && (
          <div className="text-[12px] text-[var(--text-muted)] border border-dashed border-[var(--border)] rounded-lg px-3 py-4 text-center">
            No agents yet. Create one to give a session its own instructions or model.
          </div>
        )}

        {agents.map((agent) => {
          const open = openId === agent.id;
          const plabel = providerLabel(agent.provider);
          return (
            <div
              key={agent.id}
              className="border border-[var(--border)] rounded-lg overflow-hidden bg-[var(--bg-primary)]"
            >
              {/* Row header */}
              <div className="flex items-center gap-2 px-2.5 py-2">
                <button
                  onClick={() => setOpenId(open ? null : agent.id)}
                  className="flex items-center gap-2 flex-1 min-w-0 text-left"
                >
                  {open ? (
                    <ChevronDown size={13} className="text-[var(--text-muted)] flex-shrink-0" />
                  ) : (
                    <ChevronRight size={13} className="text-[var(--text-muted)] flex-shrink-0" />
                  )}
                  <span
                    className="w-2.5 h-2.5 rounded-full flex-shrink-0"
                    style={{ background: agent.color }}
                  />
                  <span className="text-[13px] text-[var(--text-primary)] truncate">{agent.name || 'Untitled'}</span>
                  {plabel && (
                    <span className="text-[9px] px-1 py-px rounded bg-[var(--bg-tertiary)] text-[var(--text-muted)] flex-shrink-0">
                      {plabel}
                      {agent.model ? ` · ${agent.model}` : ''}
                    </span>
                  )}
                </button>
                <button
                  onClick={() => {
                    removeAiAgent(agent.id);
                    if (openId === agent.id) setOpenId(null);
                  }}
                  className="p-1 rounded hover:bg-[var(--bg-tertiary)] text-[var(--text-muted)] hover:text-[var(--accent-danger)] flex-shrink-0"
                  title="Delete agent"
                >
                  <Trash2 size={13} />
                </button>
              </div>

              {/* Editor */}
              {open && (
                <div className="px-2.5 pb-3 pt-1 space-y-2.5 border-t border-[var(--border)]">
                  <div>
                    <label className="block text-[11px] text-[var(--text-secondary)] mb-1">Name</label>
                    <input
                      value={agent.name}
                      onChange={(e) => updateAiAgent(agent.id, { name: e.target.value })}
                      placeholder="e.g. Read-only Auditor"
                      className="w-full h-8 px-2 bg-[var(--bg-secondary)] border border-[var(--border)] rounded-lg text-[13px] text-[var(--text-primary)] placeholder-[var(--text-muted)] focus:outline-none focus:border-[var(--accent)]"
                    />
                  </div>

                  <div>
                    <label className="block text-[11px] text-[var(--text-secondary)] mb-1">Colour</label>
                    <div className="flex gap-1.5">
                      {AGENT_COLORS.map((c) => (
                        <button
                          key={c}
                          onClick={() => updateAiAgent(agent.id, { color: c })}
                          className={`w-5 h-5 rounded-full transition-transform ${
                            agent.color === c ? 'ring-2 ring-offset-1 ring-offset-[var(--bg-primary)] ring-[var(--text-secondary)] scale-110' : ''
                          }`}
                          style={{ background: c }}
                          title={c}
                        />
                      ))}
                    </div>
                  </div>

                  <div>
                    <label className="block text-[11px] text-[var(--text-secondary)] mb-1">Instructions</label>
                    <textarea
                      value={agent.instructions}
                      onChange={(e) => updateAiAgent(agent.id, { instructions: e.target.value })}
                      rows={4}
                      placeholder="Persona / extra system-prompt instructions for sessions using this agent — e.g. 'Read-only: never run config commands.'"
                      className="w-full px-2 py-1.5 bg-[var(--bg-secondary)] border border-[var(--border)] rounded-lg text-[12px] text-[var(--text-primary)] placeholder-[var(--text-muted)] focus:outline-none focus:border-[var(--accent)] font-mono resize-y"
                    />
                  </div>

                  <div>
                    <label className="block text-[11px] text-[var(--text-secondary)] mb-1">Provider</label>
                    <select
                      value={agent.provider || ''}
                      onChange={(e) =>
                        // Switching provider clears the model — a model id is provider-specific.
                        updateAiAgent(agent.id, { provider: e.target.value as AiProvider | '', model: '' })
                      }
                      className="w-full h-8 px-2 bg-[var(--bg-secondary)] border border-[var(--border)] rounded-lg text-[12px] text-[var(--text-primary)] focus:outline-none focus:border-[var(--accent)]"
                    >
                      <option value="">Default (use global AI provider)</option>
                      {AI_PROVIDERS.map((p) => (
                        <option key={p.value} value={p.value}>
                          {p.label}
                        </option>
                      ))}
                    </select>
                  </div>

                  {/* Provider-aware model / CLI picker */}
                  {agent.provider && (
                    <div>
                      <label className="block text-[11px] text-[var(--text-secondary)] mb-1">
                        {agent.provider === 'local-cli' ? 'CLI command' : 'Model'}
                      </label>

                      {agent.provider === 'anthropic' && (
                        <select
                          value={agent.model || ''}
                          onChange={(e) => updateAiAgent(agent.id, { model: e.target.value })}
                          className="w-full h-8 px-2 bg-[var(--bg-secondary)] border border-[var(--border)] rounded-lg text-[12px] text-[var(--text-primary)] focus:outline-none focus:border-[var(--accent)]"
                        >
                          <option value="">Provider default (Sonnet 4.6)</option>
                          {ANTHROPIC_MODELS.map((m) => (
                            <option key={m.value} value={m.value}>
                              {m.label}
                            </option>
                          ))}
                        </select>
                      )}

                      {agent.provider === 'local-cli' && (
                        <>
                          <div className="flex gap-1.5 mb-1.5">
                            {AI_CLI_PRESETS.map((p) => (
                              <button
                                key={p.label}
                                onClick={() => updateAiAgent(agent.id, { model: p.command })}
                                className={`flex-1 py-1.5 text-[11px] rounded-lg border transition-colors ${
                                  (agent.model || '') === p.command
                                    ? 'bg-[var(--bg-tertiary)] border-[var(--accent)] text-[var(--text-primary)]'
                                    : 'bg-[var(--bg-secondary)] border-[var(--border)] text-[var(--text-secondary)] hover:border-[var(--text-muted)]'
                                }`}
                              >
                                {p.label}
                              </button>
                            ))}
                          </div>
                          <input
                            value={agent.model || ''}
                            onChange={(e) => updateAiAgent(agent.id, { model: e.target.value })}
                            placeholder="claude -p"
                            className="w-full h-8 px-2 bg-[var(--bg-secondary)] border border-[var(--border)] rounded-lg text-[12px] text-[var(--text-primary)] placeholder-[var(--text-muted)] focus:outline-none focus:border-[var(--accent)] font-mono"
                          />
                        </>
                      )}

                      {(agent.provider === 'ollama' ||
                        agent.provider === 'openrouter' ||
                        agent.provider === 'moonshot') && (
                        <>
                          <input
                            list={`agent-models-${agent.id}`}
                            value={agent.model || ''}
                            onChange={(e) => updateAiAgent(agent.id, { model: e.target.value })}
                            placeholder={
                              agent.provider === 'ollama'
                                ? 'llama3.2 (provider default)'
                                : agent.provider === 'openrouter'
                                  ? 'anthropic/claude-3.5-sonnet (provider default)'
                                  : 'kimi-k2-0905-preview (provider default)'
                            }
                            className="w-full h-8 px-2 bg-[var(--bg-secondary)] border border-[var(--border)] rounded-lg text-[12px] text-[var(--text-primary)] placeholder-[var(--text-muted)] focus:outline-none focus:border-[var(--accent)] font-mono"
                          />
                          <datalist id={`agent-models-${agent.id}`}>
                            {(agent.provider === 'ollama'
                              ? OLLAMA_COMMON
                              : agent.provider === 'openrouter'
                                ? OPENROUTER_COMMON
                                : MOONSHOT_MODELS
                            ).map((m) => (
                              <option key={m} value={m} />
                            ))}
                          </datalist>
                        </>
                      )}
                    </div>
                  )}

                  <p className="text-[10px] text-[var(--text-muted)]">
                    {agent.provider
                      ? 'Pick from the list or type your own. Leave the model blank to use the provider’s default.'
                      : 'On “Default”, this agent uses whatever provider + model is set in AI Assistant above. Choose a provider to give it its own model.'}
                  </p>
                </div>
              )}
            </div>
          );
        })}
      </div>
    </section>
  );
}
