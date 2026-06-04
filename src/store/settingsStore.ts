import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import { TerminalSettings, DEFAULT_SETTINGS, AiProvider, CentralAccount, AiAgent } from '../types';

interface SettingsState extends TerminalSettings {
  // Actions
  setTheme: (theme: 'dark' | 'light') => void;
  setFontSize: (size: number) => void;
  setFontFamily: (family: string) => void;
  setBell: (enabled: boolean) => void;
  setScrollback: (lines: number) => void;
  setCursorStyle: (style: 'block' | 'underline' | 'bar') => void;
  setCursorBlink: (enabled: boolean) => void;
  setAutoReconnect: (enabled: boolean) => void;
  setKeepAliveInterval: (seconds: number) => void;
  setSyntaxHighlighting: (enabled: boolean) => void;
  setWordWrap: (enabled: boolean) => void;
  setSidebarWidth: (width: number) => void;
  setAnthropicApiKey: (key: string) => void;
  setAiModel: (model: string) => void;
  setAiProvider: (provider: AiProvider) => void;
  setOllamaUrl: (url: string) => void;
  setOllamaModel: (model: string) => void;
  setOpenrouterModel: (model: string) => void;
  setMoonshotModel: (model: string) => void;
  setLocalCliCommand: (command: string) => void;
  setAiReferences: (refs: string) => void;
  // AI agents (per-session personas)
  addAiAgent: (agent: AiAgent) => void;
  updateAiAgent: (id: string, patch: Partial<AiAgent>) => void;
  removeAiAgent: (id: string) => void;
  setSessionAgent: (sessionId: string, agentId: string | null) => void;
  resetToDefaults: () => void;
  updateSettings: (partial: Partial<TerminalSettings>) => void;
}

export const useSettingsStore = create<SettingsState>()(
  persist(
    (set) => ({
      ...DEFAULT_SETTINGS,

      setTheme: (theme) => set({ theme }),
      setFontSize: (fontSize) => set({ fontSize }),
      setFontFamily: (fontFamily) => set({ fontFamily }),
      setBell: (bell) => set({ bell }),
      setScrollback: (scrollback) => set({ scrollback }),
      setCursorStyle: (cursorStyle) => set({ cursorStyle }),
      setCursorBlink: (cursorBlink) => set({ cursorBlink }),
      setAutoReconnect: (autoReconnect) => set({ autoReconnect }),
      setKeepAliveInterval: (keepAliveInterval) => set({ keepAliveInterval }),
      setSyntaxHighlighting: (syntaxHighlighting) => set({ syntaxHighlighting }),
      setWordWrap: (wordWrap) => set({ wordWrap }),
      setSidebarWidth: (sidebarWidth) => set({ sidebarWidth }),
      setAnthropicApiKey: (anthropicApiKey) => set({ anthropicApiKey }),
      setAiModel: (aiModel) => set({ aiModel }),
      setAiProvider: (aiProvider) => set({ aiProvider }),
      setOllamaUrl: (ollamaUrl) => set({ ollamaUrl }),
      setOllamaModel: (ollamaModel) => set({ ollamaModel }),
      setOpenrouterModel: (openrouterModel) => set({ openrouterModel }),
      setMoonshotModel: (moonshotModel) => set({ moonshotModel }),
      setLocalCliCommand: (localCliCommand) => set({ localCliCommand }),
      setAiReferences: (aiReferences) => set({ aiReferences }),

      addAiAgent: (agent) => set((s) => ({ aiAgents: [...(s.aiAgents ?? []), agent] })),
      updateAiAgent: (id, patch) =>
        set((s) => ({
          aiAgents: (s.aiAgents ?? []).map((a) => (a.id === id ? { ...a, ...patch } : a)),
        })),
      removeAiAgent: (id) =>
        set((s) => {
          // Detach the deleted agent from any session it was assigned to.
          const sessionAgents = { ...(s.sessionAgents ?? {}) };
          for (const key of Object.keys(sessionAgents)) {
            if (sessionAgents[key] === id) delete sessionAgents[key];
          }
          return { aiAgents: (s.aiAgents ?? []).filter((a) => a.id !== id), sessionAgents };
        }),
      setSessionAgent: (sessionId, agentId) =>
        set((s) => {
          const sessionAgents = { ...(s.sessionAgents ?? {}) };
          if (agentId) sessionAgents[sessionId] = agentId;
          else delete sessionAgents[sessionId];
          return { sessionAgents };
        }),

      resetToDefaults: () => set({ ...DEFAULT_SETTINGS }),

      updateSettings: (partial) => set((state) => ({ ...state, ...partial })),
    }),
    {
      name: 'atp-settings',
      // Keep plaintext secrets OUT of localStorage (it sits unencrypted on disk).
      // API keys live in the Rust key store; Central/Apstra secrets stay in memory
      // for the session (and Rust holds the configured copy). Account metadata
      // still persists, just without its secret material — re-enter on next load.
      partialize: (state) => {
        const {
          anthropicApiKey: _k,
          centralToken: _t,
          centralClientSecret: _cs,
          apstraPassword: _ap,
          mistToken: _mt,
          centralAccounts,
          ...rest
        } = state;
        return {
          ...rest,
          centralAccounts: (centralAccounts as CentralAccount[] | undefined)?.map((a) => ({
            ...a,
            clientSecret: '',
            token: '',
          })),
        };
      },
    }
  )
);
