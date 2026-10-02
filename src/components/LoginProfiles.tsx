import { useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { KeyRound, Plus, Trash2, ChevronDown, ChevronRight, Eye, EyeOff, Lock } from 'lucide-react';
import { useSettingsStore } from '../store/settingsStore';
import { useSessionStore } from '../store/sessionStore';
import { askConfirm } from '../store/dialogStore';
import { notify } from '../store/toastStore';
import { LoginProfile } from '../types';
import { generateId } from '../utils';
import { describeLoginUsage, loginSecretKey, loginUsage, withoutLogin } from '../utils/logins';
import { saveToVault } from '../utils/vaultAccess';

const NO_LOGINS: LoginProfile[] = [];

/** Password box with a show/hide toggle (the value never leaves this form
 *  except into the vault). */
function PasswordInput({
  value,
  onChange,
  placeholder,
  onEnter,
}: {
  value: string;
  onChange: (v: string) => void;
  placeholder: string;
  onEnter?: () => void;
}) {
  const [show, setShow] = useState(false);
  return (
    <div className="relative flex-1 min-w-0">
      <input
        type={show ? 'text' : 'password'}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && onEnter) {
            e.preventDefault();
            onEnter();
          }
        }}
        placeholder={placeholder}
        autoComplete="new-password"
        className="input-field w-full h-8 pl-2 pr-8 text-sm"
      />
      <button
        type="button"
        onClick={() => setShow(!show)}
        className="absolute right-1.5 top-1/2 -translate-y-1/2 p-1 text-[var(--text-secondary)] hover:text-[var(--text-primary)]"
        title={show ? 'Hide' : 'Show'}
      >
        {show ? <EyeOff size={13} /> : <Eye size={13} />}
      </button>
    </div>
  );
}

/**
 * Settings → Connections & Security → Shared Logins: shared logins (e.g. the TACACS account) that folders and
 * hosts point at. Name and username live in settings; the password only in
 * the vault, so a password rotation is one change here instead of one per host.
 */
export default function LoginProfiles() {
  const profiles = useSettingsStore((s) => s.loginProfiles) ?? NO_LOGINS;
  const addLoginProfile = useSettingsStore((s) => s.addLoginProfile);
  const updateLoginProfile = useSettingsStore((s) => s.updateLoginProfile);
  const removeLoginProfile = useSettingsStore((s) => s.removeLoginProfile);
  const folders = useSessionStore((s) => s.folders);
  const vaultUnlocked = useSessionStore((s) => s.vaultUnlocked);
  const [openId, setOpenId] = useState<string | null>(null);
  const [newPassword, setNewPassword] = useState('');
  const [adding, setAdding] = useState(false);
  const [draft, setDraft] = useState({ name: '', username: '', password: '' });

  const savePassword = async (profile: LoginProfile, password: string) => {
    if ((await saveToVault(loginSecretKey(profile.id), password)) === 'saved') {
      notify.success('Password saved', `Every host using "${profile.name}" uses it from its next connect.`);
    } else {
      notify.info('Unlock the vault to save the password', 'It is kept until you unlock.');
      useSessionStore.getState().setShowVaultUnlock(true);
    }
  };

  const create = async () => {
    const name = draft.name.trim();
    const username = draft.username.trim();
    if (!name || !username) return;
    const profile: LoginProfile = { id: `login-${generateId()}`, name, username };
    addLoginProfile(profile);
    const password = draft.password;
    setDraft({ name: '', username: '', password: '' });
    setAdding(false);
    if (password) await savePassword(profile, password);
  };

  const remove = async (profile: LoginProfile) => {
    const usage = loginUsage(profile.id, folders, profiles);
    const ok = await askConfirm({
      title: `Delete the "${profile.name}" login?`,
      message: describeLoginUsage(usage),
      confirmLabel: 'Delete login',
      danger: true,
    });
    if (!ok) return;
    removeLoginProfile(profile.id);
    if (openId === profile.id) setOpenId(null);
    // Unassign it everywhere, so no folder or host points at a missing login.
    useSessionStore.getState().setFolders(withoutLogin(useSessionStore.getState().folders, profile.id));
    invoke('clear_login_profile', { profileId: profile.id }).catch((e) =>
      notify.warning('Could not update the saved hosts', String(e))
    );
    // Removed now, or at the next unlock — no need to prompt for it.
    void saveToVault(loginSecretKey(profile.id), null);
  };

  const inputCls = 'input-field w-full h-8 px-2 text-sm';

  return (
    <section id="set-logins">
      <div className="flex items-center justify-between mb-2">
        <h3 className="text-sm font-semibold text-[var(--text-primary)] flex items-center gap-1.5">
          <KeyRound size={15} className="text-[var(--accent)]" /> Shared Logins
        </h3>
        {!adding && (
          <button
            onClick={() => setAdding(true)}
            className="flex items-center gap-1 text-[11px] px-2 py-1 rounded-md bg-[var(--bg-tertiary)] hover:bg-[var(--border-strong)] text-[var(--text-secondary)] hover:text-[var(--text-primary)]"
          >
            <Plus size={12} /> New login
          </button>
        )}
      </div>
      <p className="text-[11px] text-[var(--text-muted)] mb-3">
        One username and password used by many devices, like your TACACS or RADIUS account. Make it
        a folder&apos;s default (right-click the folder →{' '}
        <span className="text-[var(--text-secondary)]">Default login…</span>) or pick it for a host in{' '}
        <span className="text-[var(--text-secondary)]">Edit…</span>. When the password changes,
        update it here once and every host that uses the login gets it. Passwords are kept in the
        encrypted vault.
      </p>

      {!vaultUnlocked && (
        <div className="flex items-center justify-between gap-2 mb-3 px-2.5 py-2 rounded-lg border border-[var(--border)] bg-[var(--bg-inset)]">
          <span className="text-[11px] text-[var(--text-secondary)]">
            The vault is locked. Passwords saved here wait until you unlock it.
          </span>
          <button
            onClick={() => useSessionStore.getState().setShowVaultUnlock(true)}
            className="flex items-center gap-1 px-2 h-7 rounded bg-[var(--bg-tertiary)] hover:bg-[var(--border-strong)] text-[11px] text-[var(--text-primary)] flex-shrink-0"
          >
            <Lock size={11} /> Unlock
          </button>
        </div>
      )}

      {adding && (
        <div className="mb-3 p-2.5 space-y-2 rounded-lg border border-[var(--accent)] bg-[var(--bg-primary)]">
          <div className="grid grid-cols-2 gap-2">
            <div>
              <label className="block text-[11px] text-[var(--text-secondary)] mb-1">Name</label>
              <input
                autoFocus
                value={draft.name}
                onChange={(e) => setDraft({ ...draft, name: e.target.value })}
                placeholder="e.g. TACACS admin"
                className={inputCls}
              />
            </div>
            <div>
              <label className="block text-[11px] text-[var(--text-secondary)] mb-1">Username</label>
              <input
                value={draft.username}
                onChange={(e) => setDraft({ ...draft, username: e.target.value })}
                placeholder="e.g. jdoe"
                autoComplete="off"
                className={inputCls}
              />
            </div>
          </div>
          <div>
            <label className="block text-[11px] text-[var(--text-secondary)] mb-1">
              Password (optional — you can also save it the first time you connect)
            </label>
            <PasswordInput
              value={draft.password}
              onChange={(password) => setDraft({ ...draft, password })}
              placeholder="Password"
              onEnter={() => void create()}
            />
          </div>
          <div className="flex justify-end gap-2">
            <button
              onClick={() => {
                setAdding(false);
                setDraft({ name: '', username: '', password: '' });
              }}
              className="px-3 h-8 rounded text-xs text-[var(--text-secondary)] hover:bg-[var(--bg-tertiary)]"
            >
              Cancel
            </button>
            <button
              onClick={() => void create()}
              disabled={!draft.name.trim() || !draft.username.trim()}
              className="btn-accent px-3 h-8 text-xs disabled:opacity-50 disabled:cursor-not-allowed"
            >
              Add login
            </button>
          </div>
        </div>
      )}

      <div className="space-y-2">
        {profiles.length === 0 && !adding && (
          <div className="text-[12px] text-[var(--text-muted)] border border-dashed border-[var(--border)] rounded-lg px-3 py-4 text-center">
            No shared logins yet.
          </div>
        )}

        {profiles.map((profile) => {
          const open = openId === profile.id;
          const used = loginUsage(profile.id, folders, profiles).hostCount;
          return (
            <div
              key={profile.id}
              className="border border-[var(--border)] rounded-lg overflow-hidden bg-[var(--bg-primary)]"
            >
              <div className="flex items-center gap-2 px-2.5 py-2">
                <button
                  onClick={() => {
                    setOpenId(open ? null : profile.id);
                    setNewPassword('');
                  }}
                  className="flex items-center gap-2 flex-1 min-w-0 text-left"
                >
                  {open ? (
                    <ChevronDown size={13} className="text-[var(--text-muted)] flex-shrink-0" />
                  ) : (
                    <ChevronRight size={13} className="text-[var(--text-muted)] flex-shrink-0" />
                  )}
                  <span className="text-[13px] text-[var(--text-primary)] truncate">
                    {profile.name || 'Untitled'}
                  </span>
                  <span className="text-[11px] text-[var(--text-muted)] truncate">{profile.username}</span>
                  <span className="ml-auto text-[10px] text-[var(--text-muted)] flex-shrink-0">
                    {used === 0 ? 'Not used yet' : `Used by ${used} host${used === 1 ? '' : 's'}`}
                  </span>
                </button>
                <button
                  onClick={() => void remove(profile)}
                  className="p-1 rounded hover:bg-[var(--bg-tertiary)] text-[var(--text-muted)] hover:text-[var(--accent-danger)] flex-shrink-0"
                  title="Delete login"
                >
                  <Trash2 size={13} />
                </button>
              </div>

              {open && (
                <div className="px-2.5 pb-3 pt-2 space-y-2.5 border-t border-[var(--border)]">
                  <div className="grid grid-cols-2 gap-2">
                    <div>
                      <label className="block text-[11px] text-[var(--text-secondary)] mb-1">Name</label>
                      <input
                        value={profile.name}
                        onChange={(e) => updateLoginProfile(profile.id, { name: e.target.value })}
                        className={inputCls}
                      />
                    </div>
                    <div>
                      <label className="block text-[11px] text-[var(--text-secondary)] mb-1">Username</label>
                      <input
                        value={profile.username}
                        onChange={(e) => updateLoginProfile(profile.id, { username: e.target.value })}
                        autoComplete="off"
                        className={inputCls}
                      />
                    </div>
                  </div>
                  <div>
                    <label className="block text-[11px] text-[var(--text-secondary)] mb-1">Change password</label>
                    <div className="flex gap-2">
                      <PasswordInput
                        value={newPassword}
                        onChange={setNewPassword}
                        placeholder="New password"
                        onEnter={() => {
                          if (!newPassword) return;
                          void savePassword(profile, newPassword);
                          setNewPassword('');
                        }}
                      />
                      <button
                        onClick={() => {
                          void savePassword(profile, newPassword);
                          setNewPassword('');
                        }}
                        disabled={!newPassword}
                        className="px-3 h-8 rounded bg-[var(--bg-tertiary)] hover:bg-[var(--border-strong)] text-xs text-[var(--text-primary)] disabled:opacity-50 flex-shrink-0"
                      >
                        Save password
                      </button>
                    </div>
                    <p className="text-[10px] text-[var(--text-muted)] mt-1">
                      Replaces the saved password for every host that uses this login. Hosts with their
                      own username keep it.
                    </p>
                  </div>
                </div>
              )}
            </div>
          );
        })}
      </div>
    </section>
  );
}
