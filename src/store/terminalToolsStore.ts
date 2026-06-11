import { create } from 'zustand';

export interface PasteHistoryEntry {
  id: string;
  sessionId: string;
  sessionName: string;
  text: string;
  lineCount: number;
  createdAt: number;
}

interface TerminalToolsState {
  pasteHistory: PasteHistoryEntry[];
  addPaste: (entry: Omit<PasteHistoryEntry, 'id' | 'createdAt'>) => void;
  removePaste: (id: string) => void;
  clearPasteHistory: (sessionId?: string) => void;
}

const MAX_PASTE_HISTORY = 30;

export function countPasteLines(text: string): number {
  return text.replace(/\r\n/g, '\n').split('\n').filter((line) => line.length > 0).length || 1;
}

export const useTerminalToolsStore = create<TerminalToolsState>()((set) => ({
  pasteHistory: [],

  addPaste: (entry) =>
    set((state) => {
      const text = entry.text;
      if (!text.trim()) return state;
      const normalized = {
        ...entry,
        text,
        lineCount: countPasteLines(text),
        id: `paste-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        createdAt: Date.now(),
      };
      const deduped = state.pasteHistory.filter(
        (item) => !(item.sessionId === normalized.sessionId && item.text === normalized.text),
      );
      return { pasteHistory: [normalized, ...deduped].slice(0, MAX_PASTE_HISTORY) };
    }),

  removePaste: (id) =>
    set((state) => ({ pasteHistory: state.pasteHistory.filter((entry) => entry.id !== id) })),

  clearPasteHistory: (sessionId) =>
    set((state) => ({
      pasteHistory: sessionId
        ? state.pasteHistory.filter((entry) => entry.sessionId !== sessionId)
        : [],
    })),
}));
