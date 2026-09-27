import { create } from 'zustand';

export type ToastKind = 'success' | 'error' | 'info' | 'warning';

/** Optional button on a toast, e.g. { label: 'Reconnect', run: () => reconnect(id) }. */
export interface ToastAction {
  label: string;
  run: () => void;
}

export interface Toast {
  id: string;
  kind: ToastKind;
  title: string;
  message?: string;
  /** ms before auto-dismiss; 0 = sticky. */
  duration: number;
  action?: ToastAction;
  /** How many pushes this card stands for (duplicates fold in; shown as ×N). */
  count: number;
  /** Bumped when a push folds in, so the card restarts its dismiss timer. */
  bumpedAt: number;
  /** Pushes with the same key fold into this card while it is on screen. */
  key: string;
  /** Grouped toasts only: the distinct messages folded in so far. */
  parts?: string[];
}

export interface ToastOptions {
  /** ms before auto-dismiss; 0 = sticky. Defaults by kind (see defaultToastDuration). */
  duration?: number;
  action?: ToastAction;
  /**
   * Fold every push with this group into one card, listing each distinct
   * message — e.g. several background tabs connecting at once. Without a
   * group, only identical kind+title+message pushes fold together.
   */
  group?: string;
}

export type ToastInput = { kind: ToastKind; title: string; message?: string } & ToastOptions;

// Cap the on-screen stack so a burst (trigger storms, connect/disconnect
// cycles) can't pile up unbounded fixed-position cards. Keep the newest 5.
export const MAX_TOASTS = 5;

/**
 * Errors stay long enough to read (10s), and an error that offers an action
 * (e.g. Reconnect) stays until dismissed — it is the user's way back.
 */
export function defaultToastDuration(kind: ToastKind, hasAction: boolean): number {
  if (kind === 'error') return hasAction ? 0 : 10_000;
  return hasAction ? 8_000 : 4_000;
}

/** "a, b, c and 2 more" — keeps a grouped card to a line or two. */
export function joinToastParts(parts: string[], shown = 3): string {
  if (parts.length <= shown) return parts.join(', ');
  return `${parts.slice(0, shown).join(', ')} and ${parts.length - shown} more`;
}

/**
 * Pure core of push(): add a toast, or fold it into a matching card that is
 * still on screen (bumping its ×N count and restarting its timer) so repeated
 * events don't stack identical cards. Returns the new list and the id of the
 * card that now shows this push.
 */
export function addToast(
  toasts: Toast[],
  input: ToastInput,
  newId: string,
  now: number,
): { toasts: Toast[]; id: string } {
  const { kind, title, message, action, group } = input;
  const duration = input.duration ?? defaultToastDuration(kind, !!action);
  const key = group
    ? `group\u0000${kind}\u0000${group}`
    : `${kind}\u0000${title}\u0000${message ?? ''}`;

  const existing = toasts.find((t) => t.key === key);
  if (existing) {
    let parts = existing.parts;
    let text = existing.message;
    if (group && message && !parts?.includes(message)) {
      parts = [...(parts ?? []), message];
      text = joinToastParts(parts);
    }
    const folded: Toast = {
      ...existing,
      title,
      message: text,
      parts,
      // The newest push decides the action and lifetime: its action refers to
      // the latest event, and a sticky push must not inherit a short timer.
      action: action ?? existing.action,
      duration,
      count: existing.count + 1,
      bumpedAt: now,
    };
    return { toasts: toasts.map((t) => (t === existing ? folded : t)), id: existing.id };
  }

  const toast: Toast = {
    id: newId,
    kind,
    title,
    message,
    duration,
    action,
    count: 1,
    bumpedAt: now,
    key,
    parts: group && message ? [message] : undefined,
  };
  return { toasts: [...toasts, toast].slice(-MAX_TOASTS), id: newId };
}

interface ToastState {
  toasts: Toast[];
  push: (t: ToastInput) => string;
  dismiss: (id: string) => void;
  clear: () => void;
}

let seq = 0;

export const useToastStore = create<ToastState>()((set) => ({
  toasts: [],
  push: (input) => {
    let id = '';
    set((s) => {
      const next = addToast(s.toasts, input, `toast-${++seq}`, Date.now());
      id = next.id;
      return { toasts: next.toasts };
    });
    return id;
  },
  dismiss: (id) => set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) })),
  clear: () => set({ toasts: [] }),
}));

const pushKind =
  (kind: ToastKind) =>
  (title: string, message?: string, opts?: ToastOptions) =>
    useToastStore.getState().push({ kind, title, message, ...opts });

/**
 * Ergonomic notifier usable anywhere (inside or outside React).
 *   notify.success('Connected', 'sw-core-01 is online')
 *   notify.error('Connection failed', err)
 *   notify.error('Session dropped', name, { action: { label: 'Reconnect', run: () => reconnect(id) } })
 */
export const notify = {
  success: pushKind('success'),
  error: pushKind('error'),
  info: pushKind('info'),
  warning: pushKind('warning'),
};
