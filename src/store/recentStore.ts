import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import { DeviceType, Protocol } from '../types';

export interface RecentConnection {
  id: string;
  name: string;
  protocol: Protocol;
  host?: string;
  port?: number;
  username?: string;
  deviceType: DeviceType;
  lastConnectedAt: number;
  /** Saved-session id, when the connection came from a stored sidebar host. */
  storedSessionId?: string;
}

interface RecentState {
  recents: RecentConnection[];
  addRecent: (entry: Omit<RecentConnection, 'id' | 'lastConnectedAt'>) => void;
  clearRecents: () => void;
}

const MAX_RECENTS = 8;

const id = () => Math.random().toString(36).slice(2);

// Identity for dedupe: a saved session is its stored id (rename-proof); ad-hoc
// connections collapse on protocol+host+port+username (local shells become one row).
const keyOf = (r: Pick<RecentConnection, 'protocol' | 'host' | 'port' | 'username' | 'storedSessionId'>) =>
  r.storedSessionId
    ? `saved:${r.storedSessionId}`
    : `${r.protocol}:${r.host ?? ''}:${r.port ?? ''}:${r.username ?? ''}`;

/** Tiny relative-time formatter ("2h ago") — enough precision for the recents list. */
export function timeAgo(ts: number): string {
  const s = Math.max(0, Math.floor((Date.now() - ts) / 1000));
  if (s < 60) return 'just now';
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  return d < 7 ? `${d}d ago` : `${Math.floor(d / 7)}w ago`;
}

export const useRecentStore = create<RecentState>()(
  persist(
    (set) => ({
      recents: [],
      // Dedupe = move to front with a fresh timestamp (keeps the original id).
      addRecent: (entry) =>
        set((s) => {
          const key = keyOf(entry);
          const existing = s.recents.find((r) => keyOf(r) === key);
          const next: RecentConnection = {
            id: existing?.id ?? id(),
            ...entry,
            lastConnectedAt: Date.now(),
          };
          return {
            recents: [next, ...s.recents.filter((r) => keyOf(r) !== key)].slice(0, MAX_RECENTS),
          };
        }),
      clearRecents: () => set({ recents: [] }),
    }),
    { name: 'atp-recents' }
  )
);
