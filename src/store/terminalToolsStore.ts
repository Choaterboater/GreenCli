import { create } from 'zustand';
import { emit, listen } from '@tauri-apps/api/event';
import { appWindow } from '@tauri-apps/api/window';

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

// ── Cross-window sync ────────────────────────────────────────────────────
// Pop-out terminal windows run their own copy of this store, so a paste
// recorded there used to be invisible to the main window's Paste history
// popover. History deliberately stays IN MEMORY ONLY — pasted text routinely
// contains credentials and device configs and must not be written to
// localStorage the way settings are. Instead, every mutation is broadcast as
// a Tauri event and applied (without re-broadcast) in every other window.
const SYNC_EVENT = 'paste-history-sync';

type SyncMsg =
  | { source: string; kind: 'add'; entry: PasteHistoryEntry }
  | { source: string; kind: 'remove'; id: string }
  | { source: string; kind: 'clear'; sessionId?: string };

const windowLabel = (() => {
  try {
    return appWindow.label || 'main';
  } catch {
    return 'main'; // not running under Tauri (tests / dev browser)
  }
})();

const broadcast = (
  msg:
    | { kind: 'add'; entry: PasteHistoryEntry }
    | { kind: 'remove'; id: string }
    | { kind: 'clear'; sessionId?: string }
) => {
  emit(SYNC_EVENT, { ...msg, source: windowLabel }).catch(() => {
    /* not running under Tauri */
  });
};

// Monotonic per-window suffix (the window label disambiguates across windows):
// Math.random().toString(36) could yield as little as one usable char and two
// same-millisecond pastes could collide — a duplicate id breaks removePaste
// (deletes both) and duplicates React keys.
let pasteSeq = 0;

const withAdd = (state: TerminalToolsState, entry: PasteHistoryEntry) => {
  const deduped = state.pasteHistory.filter(
    (item) => !(item.sessionId === entry.sessionId && item.text === entry.text),
  );
  return { pasteHistory: [entry, ...deduped].slice(0, MAX_PASTE_HISTORY) };
};

const withRemove = (state: TerminalToolsState, id: string) => ({
  pasteHistory: state.pasteHistory.filter((entry) => entry.id !== id),
});

const withClear = (state: TerminalToolsState, sessionId?: string) => ({
  pasteHistory: sessionId
    ? state.pasteHistory.filter((entry) => entry.sessionId !== sessionId)
    : [],
});

export const useTerminalToolsStore = create<TerminalToolsState>()((set) => ({
  pasteHistory: [],

  addPaste: (entry) => {
    const text = entry.text;
    if (!text.trim()) return;
    const normalized: PasteHistoryEntry = {
      ...entry,
      text,
      lineCount: countPasteLines(text),
      id: `paste-${windowLabel}-${Date.now()}-${pasteSeq++}`,
      createdAt: Date.now(),
    };
    set((state) => withAdd(state, normalized));
    broadcast({ kind: 'add', entry: normalized });
  },

  removePaste: (id) => {
    set((state) => withRemove(state, id));
    broadcast({ kind: 'remove', id });
  },

  clearPasteHistory: (sessionId) => {
    set((state) => withClear(state, sessionId));
    broadcast({ kind: 'clear', sessionId });
  },
}));

// Apply mutations broadcast by the other windows (never re-broadcast — only
// user-initiated store actions above emit).
listen<SyncMsg>(SYNC_EVENT, ({ payload }) => {
  if (!payload || payload.source === windowLabel) return;
  useTerminalToolsStore.setState((state) => {
    switch (payload.kind) {
      case 'add':
        return withAdd(state, payload.entry);
      case 'remove':
        return withRemove(state, payload.id);
      case 'clear':
        return withClear(state, payload.sessionId);
      default:
        return state;
    }
  });
}).catch(() => {
  /* not running under Tauri */
});
