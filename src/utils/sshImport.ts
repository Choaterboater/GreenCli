// ~/.ssh/config import, shared by Settings (pick hosts) and the empty sidebar
// ("Import ~/.ssh/config" in one click).

import { invoke } from '@tauri-apps/api/tauri';
import { useSessionStore } from '../store/sessionStore';
import { ConnectionConfig } from '../types';
import { generateId } from '../utils';
import { parseHostSpec, splitNewHosts } from './hosts';

export interface ImportedHost {
  name: string;
  host: string;
  port: number;
  username?: string;
  identityFile?: string;
  jumpHost?: string;
}

const IMPORT_FOLDER = 'SSH config';

export function scanSshConfig(): Promise<ImportedHost[]> {
  return invoke<ImportedHost[]>('import_ssh_config');
}

/** Hosts from `hosts` that are not saved yet (in any folder). */
export function unsavedHosts(hosts: ImportedHost[]): ImportedHost[] {
  const saved = useSessionStore.getState().folders.flatMap((f) => f.items);
  return splitNewHosts(hosts, saved).fresh;
}

/**
 * Save `chosen` into the "SSH config" folder (created once). Hosts already
 * saved — same host, port and user — are skipped, so re-running the import
 * after editing ~/.ssh/config adds only what is new instead of duplicating
 * every entry.
 */
export async function importSshHosts(chosen: ImportedHost[]): Promise<{ added: number; skipped: number }> {
  const store = useSessionStore.getState();
  const fresh = unsavedHosts(chosen);
  const skipped = chosen.length - fresh.length;
  if (fresh.length === 0) return { added: 0, skipped };

  let folderId = store.folders.find((f) => f.name === IMPORT_FOLDER)?.id;
  if (!folderId) {
    folderId = await invoke<string>('create_folder', { name: IMPORT_FOLDER }).catch(
      () => `folder-${Date.now()}`
    );
    store.addFolder({ id: folderId, name: IMPORT_FOLDER, items: [], expanded: true });
  }

  let added = 0;
  for (const h of fresh) {
    const jump = h.jumpHost ? parseHostSpec(h.jumpHost) : undefined;
    const cfg: ConnectionConfig = {
      id: generateId(),
      name: h.name,
      protocol: 'ssh',
      host: h.host,
      port: h.port,
      username: h.username,
      authType: h.identityFile ? 'key' : 'password',
      keyPath: h.identityFile,
      deviceType: 'generic',
      jumpHost: jump?.host,
      jumpPort: jump?.port,
      jumpUsername: jump?.user,
    };
    const saved = await invoke('save_session', {
      config: {
        id: cfg.id,
        name: cfg.name,
        protocol: 'ssh',
        host: cfg.host,
        port: cfg.port,
        username: cfg.username,
        auth_type: cfg.authType,
        // B17 contract wire name (StoredSession.key_path ↔ JSON `keyPath`).
        keyPath: cfg.keyPath,
        device_type: 'generic',
        jump_host: cfg.jumpHost,
        jump_port: cfg.jumpPort,
        jump_username: cfg.jumpUsername,
      },
      folderId,
    })
      .then(() => true)
      .catch(() => false);
    if (saved) {
      useSessionStore.getState().addSessionToFolder(folderId, cfg);
      added++;
    }
  }
  return { added, skipped };
}

/** Toast text for an import result. */
export function importSummary({ added, skipped }: { added: number; skipped: number }): string {
  const addedText = `${added} host${added === 1 ? '' : 's'} added to "${IMPORT_FOLDER}".`;
  return skipped > 0 ? `${addedText} ${skipped} already saved, skipped.` : addedText;
}
