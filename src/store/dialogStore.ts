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
  enqueue: (req: DialogRequest) => void;
  close: () => void;
}

const useDialogStore = create<DialogState>()((set) => ({
  current: null,
  enqueue: (req) => set({ current: req }),
  close: () => set({ current: null }),
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
