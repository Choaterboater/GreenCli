import { create } from 'zustand';

/** Text another part of the app hands to the Config Editor to open in a new tab. */
export interface EditorDraft {
  name: string;
  content: string;
  language: string;
}

interface EditorInboxState {
  pending: EditorDraft[];
  /** Queue a draft; the editor (always mounted) opens it as a new tab. */
  send: (draft: EditorDraft) => void;
  /** The editor takes everything queued, in order. */
  take: () => EditorDraft[];
}

export const useEditorInbox = create<EditorInboxState>((set, get) => ({
  pending: [],
  send: (draft) => set((state) => ({ pending: [...state.pending, draft] })),
  take: () => {
    const drafts = get().pending;
    if (drafts.length) set({ pending: [] });
    return drafts;
  },
}));
