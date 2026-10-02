import { create } from 'zustand';
import type { LineSpan } from '../utils/sendSelection';

/** The editor lines an Ask AI question was about: where an AI suggestion goes
 *  back when you review it as a diff. In memory only (it holds the real
 *  secrets the AI never saw). */
export interface AiEditTarget {
  bufferId: string;
  tabName: string;
  language: string;
  /** null: the whole tab. */
  span: LineSpan | null;
  /** The lines as they were, secrets and all. */
  original: string;
  /** (hidden line, real line) pairs, to put secrets back in the suggestion. */
  secretLines: Array<[string, string]>;
}

export interface AiReview {
  code: string;
  target: AiEditTarget | null;
  /** The code block's language, for a suggestion that opens in a new tab. */
  language?: string;
}

interface AiBridgeState {
  /** A question from the editor, waiting for the AI panel to send it. */
  pendingAsk: { prompt: string; target: AiEditTarget } | null;
  ask: (prompt: string, target: AiEditTarget) => void;
  takeAsk: () => { prompt: string; target: AiEditTarget } | null;
  /** The target of each question the AI panel sent, by chat message id. */
  targets: Map<string, AiEditTarget>;
  setTarget: (messageId: string, target: AiEditTarget) => void;
  clearTargets: () => void;
  /** An AI code block the user wants to review in the editor. */
  pendingReview: AiReview | null;
  review: (review: AiReview) => void;
  takeReview: () => AiReview | null;
}

export const useAiBridge = create<AiBridgeState>((set, get) => ({
  pendingAsk: null,
  ask: (prompt, target) => set({ pendingAsk: { prompt, target } }),
  takeAsk: () => {
    const pending = get().pendingAsk;
    if (pending) set({ pendingAsk: null });
    return pending;
  },
  targets: new Map(),
  setTarget: (messageId, target) => set((s) => ({ targets: new Map(s.targets).set(messageId, target) })),
  clearTargets: () => set({ targets: new Map() }),
  pendingReview: null,
  review: (review) => set({ pendingReview: review }),
  takeReview: () => {
    const pending = get().pendingReview;
    if (pending) set({ pendingReview: null });
    return pending;
  },
}));
