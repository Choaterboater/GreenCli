import { create } from 'zustand';

/** One button of a 'choice' dialog. */
export interface DialogChoice {
  value: string;
  label: string;
  /** A short line under the label, in muted text. */
  detail?: string;
  /** danger: danger colours; accent: accent colours; plain: looks like Cancel. */
  tone?: 'plain' | 'accent' | 'danger';
}

export interface DialogRequest {
  id: string;
  type: 'confirm' | 'prompt' | 'choice';
  title: string;
  message?: string;
  defaultValue?: string;
  placeholder?: string;
  confirmLabel?: string;
  cancelLabel?: string;
  danger?: boolean;
  /** 'choice' only: one button per choice, in order. The first one gets focus. */
  choices?: DialogChoice[];
  /** 'choice' only: shown as a bulleted list. */
  notes?: string[];
  /** 'choice' only: long text (arguments) in a scrolling monospace box. */
  details?: string;
  detailsLabel?: string;
  /** Dialogs in a group can be settled from outside with cancelDialogs(group). */
  group?: string;
  resolve: (value: string | null) => void;
}

interface DialogState {
  current: DialogRequest | null;
  queue: DialogRequest[];
  enqueue: (req: DialogRequest) => void;
  close: () => void;
  /** Resolve every showing or queued dialog in `group` with null and drop it. */
  cancelGroup: (group: string) => void;
}

const useDialogStore = create<DialogState>()((set, get) => ({
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
  cancelGroup: (group) => {
    const { current, queue } = get();
    const dropped = queue.filter((d) => d.group === group);
    const kept = queue.filter((d) => d.group !== group);
    const closeCurrent = current?.group === group;
    if (closeCurrent) {
      const [next, ...rest] = kept;
      set({ current: next ?? null, queue: rest });
    } else {
      set({ queue: kept });
    }
    // Resolve after the state changed, so a resolver that opens a new dialog
    // queues behind the right one.
    if (closeCurrent && current) current.resolve(null);
    for (const d of dropped) d.resolve(null);
  },
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
  group?: string;
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
  group?: string;
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

/** Promise-based choice between several buttons. Resolves the chosen value, or null when the
 *  dialog is closed (Escape, a click outside, or cancelDialogs). */
export function askChoice(opts: {
  title: string;
  message?: string;
  notes?: string[];
  details?: string;
  detailsLabel?: string;
  choices: DialogChoice[];
  group?: string;
}): Promise<string | null> {
  return new Promise((resolve) => {
    useDialogStore.getState().enqueue({
      id: `dlg-${++dseq}`,
      type: 'choice',
      ...opts,
      resolve,
    });
  });
}

/** Resolve every showing or queued dialog in `group` with null (= Cancel / No) and drop it; other dialogs stay. */
export function cancelDialogs(group: string): void {
  useDialogStore.getState().cancelGroup(group);
}
