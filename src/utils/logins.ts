// Shared logins ("credential profiles"): one username + password used by many
// devices — typically the TACACS/RADIUS account — set as a folder's default or
// picked per host. Pure helpers shared by the connect path, the sidebar, Quick
// Connect and Settings. The password itself only ever lives in the vault.

import { ConnectionConfig, LoginProfile, SessionFolder } from '../types';

/** Host (or jump host) choice meaning "no shared login — use this host's own
 *  saved password", even when its folder has a default login. */
export const PER_HOST_PASSWORD = 'none';

/** Vault key holding a shared login's password. */
export function loginSecretKey(profileId: string): string {
  return `login:${profileId}`;
}

export interface EffectiveLogin {
  profile: LoginProfile;
  /** Comes from the folder's default rather than the host's own choice. */
  fromFolder: boolean;
}

/** True when a host logs in with a password — the only case a shared login
 *  applies to (keys and the agent carry their own identity; telnet and serial
 *  log in inside the terminal). */
export function usesPasswordLogin(
  config: Pick<ConnectionConfig, 'protocol' | 'authType'>,
): boolean {
  return config.protocol === 'ssh' && (config.authType ?? 'password') === 'password';
}

/**
 * Which shared login a host uses: its own pick, else its folder's default.
 * PER_HOST_PASSWORD opts the host out. An id whose login has since been
 * deleted counts as unset, so the host falls back to its folder instead of
 * pointing at nothing.
 */
export function effectiveLogin(
  host: Pick<ConnectionConfig, 'protocol' | 'authType' | 'loginProfileId'>,
  folderLoginId: string | undefined,
  profiles: LoginProfile[],
): EffectiveLogin | undefined {
  if (!usesPasswordLogin(host) || host.loginProfileId === PER_HOST_PASSWORD) return undefined;
  const own = host.loginProfileId
    ? profiles.find((p) => p.id === host.loginProfileId)
    : undefined;
  if (own) return { profile: own, fromFolder: false };
  const inherited = folderLoginId ? profiles.find((p) => p.id === folderLoginId) : undefined;
  return inherited ? { profile: inherited, fromFolder: true } : undefined;
}

/** The saved host a tab or sidebar item stands for. A tab's `id` is its own
 *  session id; `savedId` (when set) points at the saved host it came from.
 *  The one place that mapping lives, so it's easy to adjust. */
export function savedHostId(config: Pick<ConnectionConfig, 'id' | 'savedId'>): string {
  return config.savedId ?? config.id;
}

/** The saved host behind a tab or sidebar item, and the folder it lives in
 *  (undefined for an unsaved connect). */
export function savedHostOf(
  folders: SessionFolder[],
  config: Pick<ConnectionConfig, 'id' | 'savedId'>,
): { folder: SessionFolder; host: ConnectionConfig } | undefined {
  const id = savedHostId(config);
  for (const folder of folders) {
    const host = folder.items.find((i) => i.id === id);
    if (host) return { folder, host };
  }
  return undefined;
}

/** The login settings for a tab or sidebar item: the saved host's own choice
 *  — its sidebar item is the source of truth; a tab's copy can be stale — and
 *  its folder's default. An unsaved connect only has its own choice. */
export function loginChoiceFor(
  folders: SessionFolder[],
  config: Pick<ConnectionConfig, 'id' | 'savedId' | 'loginProfileId'>,
): { loginProfileId?: string; folderLoginProfileId?: string } {
  const saved = savedHostOf(folders, config);
  return saved
    ? { loginProfileId: saved.host.loginProfileId, folderLoginProfileId: saved.folder.loginProfileId }
    : { loginProfileId: config.loginProfileId };
}

export interface LoginUsage {
  /** Folders that have it as their default login. */
  folders: string[];
  /** Hosts that picked it themselves (for the device or its jump host). */
  hosts: string[];
  /** Every saved host that logs in with it, counting folder defaults. */
  hostCount: number;
}

/** Where a login is used — shown before deleting it, and as "used by N hosts". */
export function loginUsage(
  profileId: string,
  folders: SessionFolder[],
  profiles: LoginProfile[],
): LoginUsage {
  const usage: LoginUsage = { folders: [], hosts: [], hostCount: 0 };
  for (const folder of folders) {
    if (folder.loginProfileId === profileId) usage.folders.push(folder.name);
    for (const host of folder.items) {
      const picked = host.loginProfileId === profileId || host.jumpLoginProfileId === profileId;
      if (picked) usage.hosts.push(host.name);
      if (
        picked ||
        effectiveLogin(host, folder.loginProfileId, profiles)?.profile.id === profileId
      ) {
        usage.hostCount += 1;
      }
    }
  }
  return usage;
}

/** Folders with every reference to a deleted login dropped — the in-memory
 *  twin of the backend's clear_login_profile. */
export function withoutLogin(folders: SessionFolder[], profileId: string): SessionFolder[] {
  const clear = (id: string | undefined) => (id === profileId ? undefined : id);
  return folders.map((f) => ({
    ...f,
    loginProfileId: clear(f.loginProfileId),
    items: f.items.map((h) =>
      h.loginProfileId === profileId || h.jumpLoginProfileId === profileId
        ? {
            ...h,
            loginProfileId: clear(h.loginProfileId),
            jumpLoginProfileId: clear(h.jumpLoginProfileId),
          }
        : h,
    ),
  }));
}

/** "a, b, c and 4 more" — keeps a warning readable for a 200-host login. */
function nameList(names: string[], max = 4): string {
  if (names.length <= max) {
    return names.length > 1 ? `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}` : names.join('');
  }
  return `${names.slice(0, max).join(', ')} and ${names.length - max} more`;
}

/** The warning shown before deleting a login: who loses it, and what happens
 *  to them instead. */
export function describeLoginUsage(usage: LoginUsage): string {
  if (usage.hostCount === 0 && usage.folders.length === 0) {
    return 'No folders or hosts use it. Its saved password is removed from the vault.';
  }
  const parts: string[] = [];
  if (usage.folders.length > 0) {
    parts.push(
      `It is the default login of ${usage.folders.length === 1 ? 'folder' : 'folders'} ${nameList(usage.folders)}.`,
    );
  }
  if (usage.hosts.length > 0) {
    parts.push(`It is set directly on ${nameList(usage.hosts)}.`);
  }
  parts.push(
    `${usage.hostCount} saved ${usage.hostCount === 1 ? 'host logs' : 'hosts log'} in with it. ` +
      'They will use their folder’s login or their own saved password instead, or ask when connecting.',
  );
  return parts.join(' ');
}
