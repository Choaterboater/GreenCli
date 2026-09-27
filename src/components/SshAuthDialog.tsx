import { useState, useEffect } from 'react';
import { X, KeyRound, Eye, EyeOff, Lock, FolderOpen, FileKey, AlertTriangle, Users } from 'lucide-react';
import { invoke } from '@tauri-apps/api/tauri';
import { open as openDialog } from '@tauri-apps/api/dialog';
import { useSessionStore } from '../store/sessionStore';
import { useSettingsStore } from '../store/settingsStore';
import { notify } from '../store/toastStore';
import { hostSummary } from '../utils/hosts';
import { loginUsage } from '../utils/logins';

export interface AuthCredentials {
  authType: 'password' | 'key' | 'agent';
  /** Login name from the dialog — may differ from the pending connection's
   *  (a blank or wrong username can't be fixed by any password). */
  username?: string;
  password?: string;
  privateKey?: string;
  keyPassphrase?: string;
}

/** Where a password that works gets saved: nowhere, as this host's own
 *  password, or as the host's shared login's new password. */
export type AuthSaveChoice = 'none' | 'host' | 'login';

interface SshAuthDialogProps {
  onAuthenticate: (creds: AuthCredentials, save: AuthSaveChoice) => void;
}

export default function SshAuthDialog({ onAuthenticate }: SshAuthDialogProps) {
  const { showAuthDialog, pendingConnection, setShowAuthDialog } = useSessionStore();
  const authError = useSessionStore((s) =>
    s.pendingConnection ? s.authErrors[s.pendingConnection.id] : undefined
  );
  // The shared login this host uses, if any (see PromptLogin).
  const promptLogin = useSessionStore((s) =>
    s.pendingConnection ? s.authLogins[s.pendingConnection.id] : undefined
  );
  const folders = useSessionStore((s) => s.folders);
  const loginProfiles = useSettingsStore((s) => s.loginProfiles);
  // null = not chosen: "just this host" only if that's what was tried last.
  const [loginModeDraft, setLoginModeDraft] = useState<'login' | 'host' | null>(null);
  // null = not edited: show the pending connection's own username.
  const [usernameDraft, setUsernameDraft] = useState<string | null>(null);
  const username = usernameDraft ?? pendingConnection?.username ?? '';
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [saveCredential, setSaveCredential] = useState(false);
  const [authType, setAuthType] = useState<'password' | 'key' | 'agent'>('password');
  const [privateKey, setPrivateKey] = useState('');
  const [keyName, setKeyName] = useState<string | null>(null);
  const [keyPassphrase, setKeyPassphrase] = useState('');
  const [showKeyPassphrase, setShowKeyPassphrase] = useState(false);

  // Closing the dialog must reset ALL form state — the next prompt can be for a
  // DIFFERENT host, and carrying over the previous host's secrets, its "Save
  // credential" opt-in, or the selected auth tab is both a surprise and a leak.
  const resetForm = () => {
    setPassword('');
    setShowPassword(false);
    setSaveCredential(false);
    setAuthType('password');
    setPrivateKey('');
    setKeyName(null);
    setKeyPassphrase('');
    setShowKeyPassphrase(false);
    setUsernameDraft(null);
    setLoginModeDraft(null);
  };

  const dismiss = () => {
    // Giving up on this host ends its run of failed attempts.
    const id = useSessionStore.getState().pendingConnection?.id;
    if (id) useSessionStore.getState().clearAuthError(id);
    resetForm();
    setShowAuthDialog(false);
  };

  // A different host's prompt must never inherit what was typed for the last
  // one (a password typed for A must not be sent to — or saved for — B).
  const pendingId = pendingConnection?.id;
  useEffect(() => {
    resetForm();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pendingId]);

  // Close on Escape, matching every other modal in the app.
  useEffect(() => {
    if (!showAuthDialog) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      dismiss();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [showAuthDialog]);

  if (!showAuthDialog || !pendingConnection) return null;

  const browseForKey = async () => {
    try {
      const picked = await openDialog({
        title: 'Select SSH private key',
        multiple: false,
        directory: false,
        // ~/.ssh keys usually have no extension; offer common ones + all files.
        filters: [
          { name: 'SSH keys', extensions: ['pem', 'key', 'ppk', 'id_rsa', 'id_ed25519'] },
          { name: 'All files', extensions: ['*'] },
        ],
      });
      const path = typeof picked === 'string' ? picked : null;
      if (!path) return;
      const text = await invoke<string>('read_file_text', { path });
      setPrivateKey(text);
      setKeyName(path.replace(/\\/g, '/').split('/').pop() || path);
    } catch (e) {
      notify.error('Could not read key file', String(e));
    }
  };

  // A shared login offers "update the login" vs "just this host" — except
  // after Skip on a locked vault, where its password just can't be read.
  const offerLogin = !!promptLogin && promptLogin.reason !== 'locked';
  const loginMode = loginModeDraft ?? (promptLogin?.reason === 'hostPassword' ? 'host' : 'login');

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    const user = username.trim();
    if (authType === 'password') {
      const save: AuthSaveChoice =
        offerLogin && loginMode === 'login'
          ? 'login'
          : saveCredential && promptLogin?.reason !== 'locked'
            ? 'host'
            : 'none';
      onAuthenticate({ authType: 'password', username: user, password }, save);
    } else if (authType === 'agent') {
      onAuthenticate({ authType: 'agent', username: user }, 'none');
    } else {
      // Only passwords are ever saved to the vault — keys stay in their files.
      onAuthenticate(
        { authType: 'key', username: user, privateKey, keyPassphrase: keyPassphrase || undefined },
        'none'
      );
    }
    resetForm();
    setShowAuthDialog(false);
  };

  // No username yet: start there, it's what's missing.
  const focusUsername = !username.trim();
  // How many saved hosts a login update reaches — the reason to prefer it.
  const loginReach = promptLogin
    ? loginUsage(promptLogin.id, folders, loginProfiles ?? []).hostCount
    : 0;
  // Live: follows the Username field as it's edited.
  const target = hostSummary({ ...pendingConnection, username: username.trim() });

  const tab = (t: 'password' | 'key' | 'agent', label: string) => (
    <button
      type="button"
      onClick={() => setAuthType(t)}
      className={`flex-1 py-1.5 text-sm rounded-md transition-colors ${
        authType === t
          ? 'bg-[var(--bg-tertiary)] text-[var(--text-primary)] shadow-elevation-1'
          : 'text-[var(--text-secondary)] hover:text-[var(--text-primary)]'
      }`}
    >
      {label}
    </button>
  );

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center modal-backdrop animate-fade-in"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) dismiss();
      }}
    >
      <div className="surface-elevated w-[440px] max-w-[94vw] animate-scale-in">
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-4 border-b border-[var(--border)]">
          <div className="flex items-center gap-2.5 min-w-0">
            <div className="flex items-center justify-center w-7 h-7 rounded-md flex-shrink-0" style={{ background: 'var(--accent-soft)' }}>
              <KeyRound size={15} style={{ color: 'var(--accent)' }} />
            </div>
            {/* Name the device — with several prompts queued, "Authentication"
                alone didn't say which session this password was for. */}
            <h2 className="text-[16px] font-semibold text-[var(--text-primary)] truncate">
              {pendingConnection.name || pendingConnection.host || 'Authentication'}
            </h2>
          </div>
          <button
            onClick={dismiss}
            className="p-1.5 rounded-md hover:bg-[var(--bg-tertiary)] text-[var(--text-secondary)] hover:text-[var(--text-primary)] transition-colors"
          >
            <X size={18} />
          </button>
        </div>

        {/* Target */}
        <div className="px-5 py-3 bg-[var(--bg-inset)] border-b border-[var(--border)]">
          <div className="flex items-center gap-2 text-sm">
            <span className="text-[var(--text-secondary)]">Logging in to</span>
            <span className="font-mono truncate" style={{ color: 'var(--accent)' }}>
              {target}
            </span>
          </div>
          {promptLogin && (
            <div className="flex items-center gap-1.5 mt-1 text-[11px] text-[var(--text-muted)]">
              <Users size={11} className="flex-shrink-0" />
              <span className="truncate">
                Shared login <span className="text-[var(--text-secondary)]">{promptLogin.name}</span>
                {promptLogin.reason === 'missing' && ' — no password saved for it yet'}
              </span>
            </div>
          )}
        </div>

        <form onSubmit={handleSubmit} className="px-5 py-4 space-y-4">
          {/* Why we're asking again — the error toast is hidden behind this modal. */}
          {authError && (
            <div
              role="alert"
              className="flex items-start gap-2 px-3 py-2 rounded-[var(--radius)] text-[12px] leading-relaxed"
              style={{ background: 'rgba(240,83,63,0.12)', color: 'var(--accent-danger)', border: '1px solid rgba(240,83,63,0.3)' }}
            >
              <AlertTriangle size={14} className="flex-shrink-0 mt-0.5" />
              <div className="min-w-0">
                <p>
                  <span className="font-semibold">
                    {authError.login
                      ? `Login "${authError.login.name}" was rejected (attempt ${authError.attempts}).`
                      : `Access denied (attempt ${authError.attempts}).`}
                  </span>{' '}
                  Several failures can lock the account on TACACS/RADIUS.
                </p>
                <p className="mt-0.5 font-mono text-[11px] opacity-80 break-words">{authError.message}</p>
              </div>
            </div>
          )}

          {/* Username — editable, since a blank or wrong one can never log in */}
          <div>
            <label className="block text-[11px] font-semibold uppercase tracking-wide text-[var(--text-secondary)] mb-1.5">
              Username
            </label>
            <input
              type="text"
              value={username}
              onChange={(e) => setUsernameDraft(e.target.value)}
              autoFocus={focusUsername}
              autoComplete="username"
              required
              className="input-field w-full h-9 px-3 text-sm"
            />
          </div>

          {/* Tabs */}
          <div className="flex gap-1 p-1 bg-[var(--bg-inset)] rounded-lg">
            {tab('password', 'Password')}
            {tab('key', 'Key')}
            {tab('agent', 'SSH Agent')}
          </div>

          {authType === 'agent' ? (
            <div className="px-3 py-4 rounded-[var(--radius)] border border-[var(--border)] bg-[var(--bg-inset)] text-[12px] text-[var(--text-secondary)] leading-relaxed">
              Authenticate with your running <strong>ssh-agent</strong> (uses <code className="text-[var(--accent)]">SSH_AUTH_SOCK</code> on macOS/Linux, or the OpenSSH/Pageant pipe on Windows). It tries each loaded key — run <code>ssh-add -l</code> to check. Click <strong>Authenticate</strong>.
            </div>
          ) : authType === 'password' ? (
            <div>
              <label className="block text-[11px] font-semibold uppercase tracking-wide text-[var(--text-secondary)] mb-1.5">
                Password
              </label>
              <div className="relative">
                <input
                  type={showPassword ? 'text' : 'password'}
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  autoFocus={!focusUsername}
                  className="input-field w-full h-9 pl-3 pr-10 text-sm"
                />
                <button
                  type="button"
                  onClick={() => setShowPassword(!showPassword)}
                  className="absolute right-2 top-1/2 -translate-y-1/2 p-1 text-[var(--text-secondary)] hover:text-[var(--text-primary)]"
                >
                  {showPassword ? <EyeOff size={14} /> : <Eye size={14} />}
                </button>
              </div>
              {/* An empty password is allowed on purpose — the app no longer
                  sends one by itself, so this is the only way to reach gear
                  that has none (e.g. a factory-default AOS-CX "admin"). */}
              {!password && (
                <p className="mt-1 text-[10px] text-[var(--text-muted)]">
                  Leave empty only for a device with no password set.
                </p>
              )}
              {promptLogin?.reason === 'locked' && (
                <p className="mt-1 text-[11px] text-[var(--text-muted)]">
                  The vault is locked, so type the password for the &ldquo;{promptLogin.name}&rdquo;
                  login. It&apos;s used for this connection only.
                </p>
              )}
            </div>
          ) : (
            <div className="space-y-3">
              <div>
                <div className="flex items-center justify-between mb-1.5">
                  <label className="text-[11px] font-semibold uppercase tracking-wide text-[var(--text-secondary)]">
                    Private Key
                  </label>
                  <button
                    type="button"
                    onClick={browseForKey}
                    className="flex items-center gap-1.5 px-2 py-1 text-[11px] rounded-md bg-[var(--bg-tertiary)] hover:bg-[var(--border-strong)] text-[var(--text-primary)] transition-colors"
                  >
                    <FolderOpen size={12} />
                    Browse…
                  </button>
                </div>
                {keyName ? (
                  <div className="flex items-center gap-2 px-3 h-9 rounded-[var(--radius)] border border-[var(--accent)] bg-[var(--accent-soft)]">
                    <FileKey size={14} style={{ color: 'var(--accent)' }} />
                    <span className="text-xs text-[var(--text-primary)] truncate flex-1">{keyName}</span>
                    <button
                      type="button"
                      onClick={() => {
                        setPrivateKey('');
                        setKeyName(null);
                      }}
                      className="text-[var(--text-muted)] hover:text-[var(--accent-danger)]"
                    >
                      <X size={13} />
                    </button>
                  </div>
                ) : (
                  <textarea
                    value={privateKey}
                    onChange={(e) => setPrivateKey(e.target.value)}
                    placeholder="Browse for a key file, or paste a PEM here…&#10;-----BEGIN OPENSSH PRIVATE KEY-----"
                    rows={3}
                    className="input-field w-full px-3 py-2 text-xs font-mono resize-none"
                  />
                )}
              </div>
              <div>
                <label className="block text-[11px] font-semibold uppercase tracking-wide text-[var(--text-secondary)] mb-1.5">
                  Key Passphrase (optional)
                </label>
                <div className="relative">
                  <input
                    type={showKeyPassphrase ? 'text' : 'password'}
                    value={keyPassphrase}
                    onChange={(e) => setKeyPassphrase(e.target.value)}
                    className="input-field w-full h-9 pl-3 pr-10 text-sm"
                  />
                  <button
                    type="button"
                    onClick={() => setShowKeyPassphrase(!showKeyPassphrase)}
                    className="absolute right-2 top-1/2 -translate-y-1/2 p-1 text-[var(--text-secondary)] hover:text-[var(--text-primary)]"
                  >
                    {showKeyPassphrase ? <EyeOff size={14} /> : <Eye size={14} />}
                  </button>
                </div>
              </div>
            </div>
          )}

          {/* Shared login: fix it once for every host, or go around it here */}
          {authType === 'password' && offerLogin && promptLogin && (
            <div className="space-y-2" role="radiogroup" aria-label="Where this password goes">
              <label className="flex items-start gap-2 cursor-pointer">
                <input
                  type="radio"
                  name="login-mode"
                  checked={loginMode === 'login'}
                  onChange={() => setLoginModeDraft('login')}
                  className="mt-0.5"
                />
                <span className="text-sm text-[var(--text-primary)]">
                  {promptLogin.reason === 'missing'
                    ? `Save it to the "${promptLogin.name}" login`
                    : 'Update this login\u2019s password'}
                  <span className="block text-[11px] text-[var(--text-muted)]">
                    Saved to &ldquo;{promptLogin.name}&rdquo; once it works
                    {loginReach > 1 ? ` — all ${loginReach} hosts that use it get it.` : '.'}
                  </span>
                </span>
              </label>
              <label className="flex items-start gap-2 cursor-pointer">
                <input
                  type="radio"
                  name="login-mode"
                  checked={loginMode === 'host'}
                  onChange={() => setLoginModeDraft('host')}
                  className="mt-0.5"
                />
                <span className="text-sm text-[var(--text-primary)]">
                  Use a different password just for this host
                </span>
              </label>
              {loginMode === 'host' && (
                <label className="flex items-center gap-2 cursor-pointer pl-6">
                  <input
                    type="checkbox"
                    checked={saveCredential}
                    onChange={(e) => setSaveCredential(e.target.checked)}
                    className="w-4 h-4 rounded"
                  />
                  <span className="text-[12px] text-[var(--text-secondary)]">
                    Remember it for this host (it stops using &ldquo;{promptLogin.name}&rdquo;)
                  </span>
                </label>
              )}
            </div>
          )}

          {/* Save — Password tab only: keys and the agent are never stored in the vault */}
          {authType === 'password' && !promptLogin && (
            <label className="flex items-center gap-2 cursor-pointer">
              <input
                type="checkbox"
                checked={saveCredential}
                onChange={(e) => setSaveCredential(e.target.checked)}
                className="w-4 h-4 rounded"
              />
              <span className="text-sm text-[var(--text-secondary)]">Save password to encrypted vault</span>
            </label>
          )}

          {/* Actions */}
          <div className="flex items-center gap-3 pt-1">
            <button
              type="button"
              onClick={dismiss}
              className="flex-1 h-10 text-sm rounded-[var(--radius)] bg-[var(--bg-tertiary)] hover:bg-[var(--border-strong)] text-[var(--text-primary)] transition-colors"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={
                !username.trim() || (authType === 'key' && !privateKey)
              }
              className="btn-accent flex-1 flex items-center justify-center gap-2 h-10 text-sm disabled:opacity-50 disabled:cursor-not-allowed"
            >
              <Lock size={14} />
              Authenticate
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
