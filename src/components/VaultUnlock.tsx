import { useState, useEffect } from 'react';
import { X, ShieldCheck, Eye, EyeOff } from 'lucide-react';
import { invoke } from '@tauri-apps/api/tauri';
import { useSessionStore } from '../store/sessionStore';

// Master-password prompt for the credential vault.
// First time: requires typing password twice to confirm.
// Subsequent: just enter the password.
export default function VaultUnlock({
  onUnlocked,
  onCancel,
  onSkip,
  waitingFor = [],
}: {
  onUnlocked?: () => void;
  onCancel?: () => void;
  /** Connect the waiting sessions by typing their device password instead —
   *  a locked vault can't say whether it even holds one for them. */
  onSkip?: () => void;
  /** Names of the sessions whose connect is parked on this unlock. */
  waitingFor?: string[];
}) {
  const { showVaultUnlock, setShowVaultUnlock, setVaultUnlocked } = useSessionStore();
  const [pw, setPw] = useState('');
  const [confirm, setConfirm] = useState('');
  const [show, setShow] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [isNew, setIsNew] = useState(false);

  useEffect(() => {
    if (showVaultUnlock) {
      invoke<boolean>('vault_is_initialized')
        .then((init) => setIsNew(!init))
        .catch(() => setIsNew(false));
    } else {
      // The typed master password must not survive a dismissed dialog — it
      // would reappear (with any stale error) the next time it opens.
      setPw('');
      setConfirm('');
      setErr(null);
      setShow(false);
    }
  }, [showVaultUnlock]);

  // Esc = Cancel, like the other modals. Captured and stopped here: this prompt
  // sits above the rest (z-60), so the dialog underneath must not also close.
  useEffect(() => {
    if (!showVaultUnlock) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      e.preventDefault();
      e.stopPropagation();
      onCancel?.();
      setShowVaultUnlock(false);
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [showVaultUnlock, onCancel, setShowVaultUnlock]);

  if (!showVaultUnlock) return null;

  const skip = onSkip && waitingFor.length > 0 ? onSkip : undefined;

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!pw) return;
    if (isNew && pw !== confirm) {
      setErr('Passwords do not match.');
      return;
    }
    if (isNew && pw.length < 12) {
      // Matches the backend floor (vault/mod.rs). A short master password is
      // offline-brute-forceable if vault.enc is stolen — the exact threat the
      // vault exists to resist.
      setErr('Master password must be at least 12 characters.');
      return;
    }
    if (isNew && /^(.)\1*$/.test(pw)) {
      setErr('Master password is too weak. Avoid a single repeated character.');
      return;
    }
    setBusy(true);
    setErr(null);
    try {
      await invoke('vault_unlock', { password: pw });
      setVaultUnlocked(true);
      setShowVaultUnlock(false);
      setPw('');
      setConfirm('');
      onUnlocked?.();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/50 backdrop-blur-sm">
      <div className="w-[400px] bg-[var(--bg-secondary)] border border-[var(--border)] rounded-xl shadow-2xl">
        <div className="flex items-center justify-between px-5 py-4 border-b border-[var(--bg-tertiary)]">
          <div className="flex items-center gap-2">
            <ShieldCheck size={18} className="text-[#3fb950]" />
            <h2 className="text-lg font-semibold text-[var(--text-primary)]">
              {isNew ? 'Create Vault Password' : waitingFor.length > 0 ? 'Unlock the Vault' : 'Credential Vault'}
            </h2>
          </div>
          <button
            onClick={() => {
              onCancel?.();
              setShowVaultUnlock(false);
            }}
            className="p-1 rounded hover:bg-[var(--bg-tertiary)] text-[var(--text-secondary)] hover:text-[var(--text-primary)]"
          >
            <X size={18} />
          </button>
        </div>
        <form onSubmit={submit} className="px-5 py-4 space-y-3">
          <p className="text-xs text-[var(--text-secondary)]">
            {isNew ? (
              'Choose a master password (at least 12 characters) for your credential vault. You\u2019ll need this to access saved passwords.'
            ) : waitingFor.length === 1 ? (
              <>
                Unlock the vault to use the saved password for{' '}
                <span className="font-medium text-[var(--text-primary)]">{waitingFor[0]}</span>.
              </>
            ) : waitingFor.length > 1 ? (
              <>
                Unlock the vault to use saved passwords for {waitingFor.length} sessions:{' '}
                <span className="text-[var(--text-primary)]">{waitingFor.join(', ')}</span>.
              </>
            ) : (
              'Enter your vault master password to unlock saved credentials.'
            )}
          </p>
          <div className="relative">
            <input
              autoFocus
              type={show ? 'text' : 'password'}
              value={pw}
              onChange={(e) => setPw(e.target.value)}
              placeholder={isNew ? 'New master password' : 'Master password'}
              className="w-full h-9 pl-3 pr-10 bg-[var(--bg-primary)] border border-[var(--border)] rounded-lg text-sm text-[var(--text-primary)] focus:outline-none focus:border-[#58a6ff]"
            />
            <button
              type="button"
              onClick={() => setShow(!show)}
              className="absolute right-2 top-1/2 -translate-y-1/2 p-1 text-[var(--text-secondary)] hover:text-[var(--text-primary)]"
            >
              {show ? <EyeOff size={14} /> : <Eye size={14} />}
            </button>
          </div>
          {isNew && (
            <input
              type={show ? 'text' : 'password'}
              value={confirm}
              onChange={(e) => setConfirm(e.target.value)}
              placeholder="Confirm password"
              className="w-full h-9 pl-3 pr-10 bg-[var(--bg-primary)] border border-[var(--border)] rounded-lg text-sm text-[var(--text-primary)] focus:outline-none focus:border-[#58a6ff]"
            />
          )}
          {err && (
            <div className="px-3 py-2 bg-[#3d1518] border border-[#ff7b72]/30 rounded-lg text-xs text-[#ff7b72]">
              {err}
            </div>
          )}
          <button
            type="submit"
            disabled={busy || !pw || (isNew && !confirm)}
            className="w-full h-9 text-sm bg-[#238636] hover:bg-[#2ea043] disabled:opacity-50 text-white rounded-lg transition-colors"
          >
            {busy ? 'Unlocking…' : isNew ? 'Create & Unlock' : 'Unlock'}
          </button>
          {skip && (
            <button
              type="button"
              onClick={() => {
                skip();
                setShowVaultUnlock(false);
              }}
              disabled={busy}
              className="w-full h-9 text-sm rounded-lg bg-[var(--bg-tertiary)] hover:bg-[var(--border-strong)] disabled:opacity-50 text-[var(--text-primary)] transition-colors"
            >
              Skip — type the device password
            </button>
          )}
        </form>
      </div>
    </div>
  );
}
