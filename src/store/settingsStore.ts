import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import { TerminalSettings, DEFAULT_SETTINGS, AiProvider } from '../types';

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
  setAnthropicApiKey: (key: string) => void;
  setAiModel: (model: string) => void;
  setAiProvider: (provider: AiProvider) => void;
  setOllamaUrl: (url: string) => void;
  setOllamaModel: (model: string) => void;
  setOpenrouterModel: (model: string) => void;
  setMoonshotModel: (model: string) => void;
  setLocalCliCommand: (command: string) => void;
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
      setAnthropicApiKey: (anthropicApiKey) => set({ anthropicApiKey }),
      setAiModel: (aiModel) => set({ aiModel }),
      setAiProvider: (aiProvider) => set({ aiProvider }),
      setOllamaUrl: (ollamaUrl) => set({ ollamaUrl }),
      setOllamaModel: (ollamaModel) => set({ ollamaModel }),
      setOpenrouterModel: (openrouterModel) => set({ openrouterModel }),
      setMoonshotModel: (moonshotModel) => set({ moonshotModel }),
      setLocalCliCommand: (localCliCommand) => set({ localCliCommand }),

      resetToDefaults: () => set({ ...DEFAULT_SETTINGS }),

      updateSettings: (partial) => set((state) => ({ ...state, ...partial })),
    }),
    {
      name: 'atp-settings',
    }
  )
);
