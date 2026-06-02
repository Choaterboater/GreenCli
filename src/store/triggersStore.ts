import { create } from 'zustand';
import { persist } from 'zustand/middleware';

export interface Trigger {
  id: string;
  pattern: string;
  isRegex: boolean;
  /** Audible beep on match (in addition to the toast). */
  bell: boolean;
}

interface TriggersState {
  triggers: Trigger[];
  addTrigger: (t: Omit<Trigger, 'id'>) => void;
  removeTrigger: (id: string) => void;
}

export const useTriggersStore = create<TriggersState>()(
  persist(
    (set) => ({
      triggers: [],
      addTrigger: (t) =>
        set((s) => ({ triggers: [...s.triggers, { ...t, id: `trg-${Date.now()}-${s.triggers.length}` }] })),
      removeTrigger: (id) => set((s) => ({ triggers: s.triggers.filter((t) => t.id !== id) })),
    }),
    { name: 'atp-triggers' }
  )
);
