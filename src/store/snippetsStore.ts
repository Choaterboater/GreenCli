import { create } from 'zustand';
import { persist } from 'zustand/middleware';

export interface Snippet {
  id: string;
  label: string;
  command: string;
}

interface SnippetsState {
  snippets: Snippet[];
  addSnippet: (label: string, command: string) => void;
  removeSnippet: (id: string) => void;
  updateSnippet: (id: string, updates: Partial<Omit<Snippet, 'id'>>) => void;
}

const id = () => Math.random().toString(36).slice(2);

// A few useful Aruba defaults to start from.
const DEFAULTS: Snippet[] = [
  { id: id(), label: 'Interfaces', command: 'show interface brief' },
  { id: id(), label: 'VLANs', command: 'show vlan' },
  { id: id(), label: 'LLDP neighbors', command: 'show lldp neighbor-info' },
  { id: id(), label: 'Version', command: 'show version' },
  { id: id(), label: 'Running config', command: 'show running-config' },
  { id: id(), label: 'Save config', command: 'write memory' },
];

export const useSnippetsStore = create<SnippetsState>()(
  persist(
    (set) => ({
      snippets: DEFAULTS,
      addSnippet: (label, command) =>
        set((s) => ({ snippets: [...s.snippets, { id: id(), label, command }] })),
      removeSnippet: (sid) =>
        set((s) => ({ snippets: s.snippets.filter((x) => x.id !== sid) })),
      updateSnippet: (sid, updates) =>
        set((s) => ({
          snippets: s.snippets.map((x) => (x.id === sid ? { ...x, ...updates } : x)),
        })),
    }),
    { name: 'atp-snippets' }
  )
);
