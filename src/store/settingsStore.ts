import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import { TerminalSettings, TerminalColorScheme, DEFAULT_SETTINGS, AiProvider, CentralAccount, AiAgent, DeviceProfile, DeviceType } from '../types';

interface SettingsState extends TerminalSettings {
  // Actions
  setTheme: (theme: 'dark' | 'light') => void;
  setColorScheme: (scheme: TerminalColorScheme) => void;
  setFontSize: (size: number) => void;
  setFontFamily: (family: string) => void;
  setBell: (enabled: boolean) => void;
  setScrollback: (lines: number) => void;
  setCursorStyle: (style: 'block' | 'underline' | 'bar') => void;
  setCursorBlink: (enabled: boolean) => void;
  setAutoReconnect: (enabled: boolean) => void;
  setKeepAliveInterval: (seconds: number) => void;
  setSyntaxHighlighting: (enabled: boolean) => void;
  setSidebarWidth: (width: number) => void;
  setLastUsedDeviceType: (deviceType: DeviceType) => void;
  setLastUsedDeviceProfileId: (profileId: string) => void;
  addDeviceProfile: (profile: DeviceProfile) => void;
  updateDeviceProfile: (id: string, patch: Partial<DeviceProfile>) => void;
  removeDeviceProfile: (id: string) => void;
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
      setColorScheme: (colorScheme) => set({ colorScheme }),
      setFontSize: (fontSize) => set({ fontSize }),
      setFontFamily: (fontFamily) => set({ fontFamily }),
      setBell: (bell) => set({ bell }),
      setScrollback: (scrollback) => set({ scrollback }),
      setCursorStyle: (cursorStyle) => set({ cursorStyle }),
      setCursorBlink: (cursorBlink) => set({ cursorBlink }),
      setAutoReconnect: (autoReconnect) => set({ autoReconnect }),
      setKeepAliveInterval: (keepAliveInterval) => set({ keepAliveInterval }),
      setSyntaxHighlighting: (syntaxHighlighting) => set({ syntaxHighlighting }),
      setSidebarWidth: (sidebarWidth) => set({ sidebarWidth }),
      setLastUsedDeviceType: (lastUsedDeviceType) => set({ lastUsedDeviceType }),
      setLastUsedDeviceProfileId: (lastUsedDeviceProfileId) => set({ lastUsedDeviceProfileId }),
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

      addDeviceProfile: (profile) =>
        set((s) => ({
          customDeviceProfiles: [
            ...(s.customDeviceProfiles ?? []).filter((p) => p.id !== profile.id),
            profile,
          ],
        })),
      updateDeviceProfile: (id, patch) =>
        set((s) => ({
          customDeviceProfiles: (s.customDeviceProfiles ?? []).map((p) =>
            p.id === id ? { ...p, ...patch } : p
          ),
        })),
      removeDeviceProfile: (id) =>
        set((s) => ({
          customDeviceProfiles: (s.customDeviceProfiles ?? []).filter((p) => p.id !== id),
          lastUsedDeviceProfileId:
            s.lastUsedDeviceProfileId === id ? 'builtin-generic' : s.lastUsedDeviceProfileId,
          lastUsedDeviceType:
            s.lastUsedDeviceProfileId === id ? 'generic' : s.lastUsedDeviceType,
        })),

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

// Pop-out terminal windows run their own copy of this store over the same
// localStorage key. zustand's persist hydrates once at load and never watches
// for writes from other windows, so a pop-out kept enforcing whatever paste
// guard / font / theme it launched with. Re-hydrate whenever another window
// writes the key, and on window focus as a WebKit fallback (storage events
// across Tauri webviews are not guaranteed on every platform).
if (typeof window !== 'undefined') {
  window.addEventListener('storage', (e) => {
    if (e.key === null || e.key === 'atp-settings') {
      void useSettingsStore.persist.rehydrate();
    }
  });
  window.addEventListener('focus', () => {
    void useSettingsStore.persist.rehydrate();
  });
}
