import { useState, useEffect } from 'react';
import { X, KeyRound, Eye, EyeOff, Lock, FolderOpen, FileKey } from 'lucide-react';
import { invoke } from '@tauri-apps/api/tauri';
import { open as openDialog } from '@tauri-apps/api/dialog';
import { useSessionStore } from '../store/sessionStore';
import { notify } from '../store/toastStore';

export interface AuthCredentials {
  authType: 'password' | 'key' | 'agent';
  password?: string;
  privateKey?: string;
  keyPassphrase?: string;
}

interface SshAuthDialogProps {
  onAuthenticate: (creds: AuthCredentials, saveCredential: boolean) => void;
}

export default function SshAuthDialog({ onAuthenticate }: SshAuthDialogProps) {
  const { showAuthDialog, pendingConnection, setShowAuthDialog } = useSessionStore();
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
  };

  const dismiss = () => {
    resetForm();
    setShowAuthDialog(false);
  };

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

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (authType === 'password') {
      onAuthenticate({ authType: 'password', password }, saveCredential);
    } else if (authType === 'agent') {
      onAuthenticate({ authType: 'agent' }, false);
    } else {
      onAuthenticate(
        { authType: 'key', privateKey, keyPassphrase: keyPassphrase || undefined },
        saveCredential
      );
    }
    resetForm();
    setShowAuthDialog(false);
  };

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
          <div className="flex items-center gap-2.5">
            <div className="flex items-center justify-center w-7 h-7 rounded-md" style={{ background: 'var(--accent-soft)' }}>
              <KeyRound size={15} style={{ color: 'var(--accent)' }} />
            </div>
            <h2 className="text-[16px] font-semibold text-[var(--text-primary)]">Authentication</h2>
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
            <span className="text-[var(--text-secondary)]">Connecting to</span>
            <span className="font-mono" style={{ color: 'var(--accent)' }}>
              {pendingConnection.username ? `${pendingConnection.username}@` : ''}
              {pendingConnection.host}
              {pendingConnection.port && pendingConnection.port !== 22 ? `:${pendingConnection.port}` : ''}
            </span>
          </div>
        </div>

        <form onSubmit={handleSubmit} className="px-5 py-4 space-y-4">
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
                  autoFocus
                  required
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

          {/* Save — hidden on the SSH Agent tab, where nothing is persisted */}
          {authType !== 'agent' && (
            <label className="flex items-center gap-2 cursor-pointer">
              <input
                type="checkbox"
                checked={saveCredential}
                onChange={(e) => setSaveCredential(e.target.checked)}
                className="w-4 h-4 rounded"
              />
              <span className="text-sm text-[var(--text-secondary)]">Save credential to encrypted vault</span>
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
              disabled={authType === 'password' ? !password : authType === 'key' ? !privateKey : false}
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
