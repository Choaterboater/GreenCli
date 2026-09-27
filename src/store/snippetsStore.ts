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

// A few useful Aruba + Junos defaults to start from. Stable ids (not random) so
// backup merge-imports dedupe the built-ins across installs instead of
// duplicating them. Read-only on purpose: a config save shouldn't be one stray
// click away on a fresh install.
const DEFAULTS: Snippet[] = [
  { id: 'default-interfaces', label: 'Interfaces', command: 'show interface brief' },
  { id: 'default-vlans', label: 'VLANs', command: 'show vlan' },
  { id: 'default-lldp-neighbors', label: 'LLDP neighbors', command: 'show lldp neighbor-info' },
  { id: 'default-version', label: 'Version', command: 'show version' },
  { id: 'default-running-config', label: 'Running config', command: 'show running-config' },
  { id: 'default-junos-interfaces-terse', label: 'Junos interfaces', command: 'show interfaces terse' },
  { id: 'default-junos-system-alarms', label: 'Junos system alarms', command: 'show system alarms' },
  { id: 'default-junos-chassis-alarms', label: 'Junos chassis alarms', command: 'show chassis alarms' },
];

// Defaults older versions shipped. Only used to re-key v0 snippets below — an
// existing install keeps its saved `write memory` snippet; new ones don't get it.
const LEGACY_DEFAULTS: Snippet[] = [
  ...DEFAULTS,
  { id: 'default-save-config', label: 'Save config', command: 'write memory' },
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
    {
      name: 'atp-snippets',
      version: 1,
      migrate: (persisted) => {
        // v0 stamped the default snippets with random ids; re-key untouched
        // defaults (same label + command) to the stable ids so a later backup
        // merge-import doesn't duplicate them, then drop any id collisions.
        const state = persisted as Pick<SnippetsState, 'snippets'>;
        if (!Array.isArray(state?.snippets)) return state as SnippetsState;
        const seen = new Set<string>();
        const snippets = state.snippets
          .map((s) => {
            const def = LEGACY_DEFAULTS.find((d) => d.label === s.label && d.command === s.command);
            return def ? { ...s, id: def.id } : s;
          })
          .filter((s) => (seen.has(s.id) ? false : (seen.add(s.id), true)));
        return { ...state, snippets } as SnippetsState;
      },
    }
  )
);
