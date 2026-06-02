import { create } from 'zustand';

export type ToastKind = 'success' | 'error' | 'info' | 'warning';

export interface Toast {
  id: string;
  kind: ToastKind;
  title: string;
  message?: string;
  /** ms before auto-dismiss; 0 = sticky. */
  duration: number;
}

interface ToastState {
  toasts: Toast[];
  push: (t: Omit<Toast, 'id' | 'duration'> & { duration?: number }) => string;
  dismiss: (id: string) => void;
  clear: () => void;
}

let seq = 0;

export const useToastStore = create<ToastState>()((set) => ({
  toasts: [],
  push: ({ kind, title, message, duration }) => {
    const id = `toast-${++seq}`;
    const ttl = duration ?? (kind === 'error' ? 7000 : 4000);
    // Cap the on-screen stack so a burst (trigger storms, connect/disconnect
    // cycles) can't pile up unbounded fixed-position cards. Keep the newest 5.
    const MAX = 5;
    set((s) => ({ toasts: [...s.toasts, { id, kind, title, message, duration: ttl }].slice(-MAX) }));
    return id;
  },
  dismiss: (id) => set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) })),
  clear: () => set({ toasts: [] }),
}));

/**
 * Ergonomic notifier usable anywhere (inside or outside React).
 *   notify.success('Connected', 'sw-core-01 is online')
 *   notify.error('Connection failed', err)
 */
export const notify = {
  success: (title: string, message?: string) =>
    useToastStore.getState().push({ kind: 'success', title, message }),
  error: (title: string, message?: string) =>
    useToastStore.getState().push({ kind: 'error', title, message }),
  info: (title: string, message?: string) =>
    useToastStore.getState().push({ kind: 'info', title, message }),
  warning: (title: string, message?: string) =>
    useToastStore.getState().push({ kind: 'warning', title, message }),
};
