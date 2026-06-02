import { create } from 'zustand';

export interface DialogRequest {
  id: string;
  type: 'confirm' | 'prompt';
  title: string;
  message?: string;
  defaultValue?: string;
  placeholder?: string;
  confirmLabel?: string;
  cancelLabel?: string;
  danger?: boolean;
  resolve: (value: string | null) => void;
}

interface DialogState {
  current: DialogRequest | null;
  queue: DialogRequest[];
  enqueue: (req: DialogRequest) => void;
  close: () => void;
}

const useDialogStore = create<DialogState>()((set) => ({
  current: null,
  queue: [],
  // FIFO: if a dialog is already showing, queue the new one instead of clobbering
  // it (which would silently drop the first promise's resolver and hang its await).
  enqueue: (req) =>
    set((s) => (s.current ? { queue: [...s.queue, req] } : { current: req })),
  // Advance to the next queued dialog (if any) when the current one closes.
  close: () =>
    set((s) => {
      const [next, ...rest] = s.queue;
      return { current: next ?? null, queue: rest };
    }),
}));

export { useDialogStore };

let dseq = 0;

/** Promise-based confirm. Resolves true if confirmed, false otherwise. */
export function askConfirm(opts: {
  title: string;
  message?: string;
  confirmLabel?: string;
  cancelLabel?: string;
  danger?: boolean;
}): Promise<boolean> {
  return new Promise((resolve) => {
    useDialogStore.getState().enqueue({
      id: `dlg-${++dseq}`,
      type: 'confirm',
      ...opts,
      resolve: (v) => resolve(v !== null),
    });
  });
}

/** Promise-based text prompt. Resolves the entered string, or null if cancelled. */
export function askPrompt(opts: {
  title: string;
  message?: string;
  defaultValue?: string;
  placeholder?: string;
  confirmLabel?: string;
}): Promise<string | null> {
  return new Promise((resolve) => {
    useDialogStore.getState().enqueue({
      id: `dlg-${++dseq}`,
      type: 'prompt',
      ...opts,
      resolve,
    });
  });
}
