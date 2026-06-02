import { useState } from 'react';
import { Save, Trash2 } from 'lucide-react';
import { useSettingsStore } from '../store/settingsStore';
import { CENTRAL_REGIONS, CentralAccount } from '../types';
import { askPrompt } from '../store/dialogStore';
import { generateId } from '../utils';

export default function CentralSettings() {
  const s = useSettingsStore();
  const [accountId, setAccountId] = useState('');

  const saveAccount = async () => {
    if (!s.centralBaseUrl.trim()) return;
    // If an account is currently loaded, UPDATE it in place rather than appending a
    // duplicate (the old behaviour piled up copies on every edit/rotate).
    const existing = accountId ? s.centralAccounts.find((a) => a.id === accountId) : undefined;
    const name = await askPrompt({
      title: existing ? 'Update Central account' : 'Save Central account',
      placeholder: 'e.g. Prod US4',
      defaultValue: existing?.name || s.centralBaseUrl.replace(/^https?:\/\//, '').split('.')[0],
    });
    if (!name) return;
    const acct: CentralAccount = {
      id: existing?.id || generateId(),
      name,
      baseUrl: s.centralBaseUrl,
      clientId: s.centralClientId,
      clientSecret: s.centralClientSecret,
      token: s.centralToken,
      mode: s.centralAuthMode,
    };
    s.updateSettings({
      centralAccounts: existing
        ? s.centralAccounts.map((a) => (a.id === existing.id ? acct : a))
        : [...s.centralAccounts, acct],
    });
    setAccountId(acct.id);
  };

  const loadAccount = (id: string) => {
    setAccountId(id);
    const a = s.centralAccounts.find((x) => x.id === id);
    if (!a) return;
    s.updateSettings({
      centralBaseUrl: a.baseUrl,
      centralClientId: a.clientId,
      centralClientSecret: a.clientSecret,
      centralToken: a.token,
      centralAuthMode: a.mode,
    });
  };

  const deleteAccount = () => {
    if (!accountId) return;
    s.updateSettings({ centralAccounts: s.centralAccounts.filter((a) => a.id !== accountId) });
    setAccountId('');
  };

  const input =
    'w-full h-8 px-2 bg-[var(--bg-primary)] border border-[var(--border)] rounded-lg text-sm text-[var(--text-primary)] placeholder-[var(--text-muted)] focus:outline-none focus:border-[var(--accent)] font-mono';

  return (
    <section>
      <h3 className="text-sm font-semibold text-[var(--text-primary)] mb-3">Aruba Central</h3>
      <div className="space-y-3">
        {/* Saved accounts */}
        <div className="flex items-center gap-2">
          <select
            value={accountId}
            onChange={(e) => loadAccount(e.target.value)}
            className={`${input} flex-1`}
          >
            <option value="">{s.centralAccounts.length ? 'Load saved account…' : 'No saved accounts'}</option>
            {s.centralAccounts.map((a) => (
              <option key={a.id} value={a.id}>
                {a.name}
              </option>
            ))}
          </select>
          <button
            onClick={saveAccount}
            title="Save current as account"
            className="flex items-center gap-1.5 px-2.5 h-8 text-[12px] rounded-md bg-[var(--bg-tertiary)] hover:bg-[var(--border-strong)] text-[var(--text-primary)]"
          >
            <Save size={13} /> Save
          </button>
          {accountId && (
            <button
              onClick={deleteAccount}
              title="Delete account"
              className="p-1.5 rounded-md text-[var(--text-muted)] hover:text-[var(--accent-danger)] hover:bg-[var(--bg-tertiary)]"
            >
              <Trash2 size={14} />
            </button>
          )}
        </div>

        {/* Auth mode */}
        <div className="segmented w-full">
          <button
            data-active={s.centralAuthMode === 'creds'}
            onClick={() => s.updateSettings({ centralAuthMode: 'creds' })}
            className="flex-1 justify-center"
          >
            Client credentials
          </button>
          <button
            data-active={s.centralAuthMode === 'token'}
            onClick={() => s.updateSettings({ centralAuthMode: 'token' })}
            className="flex-1 justify-center"
          >
            Access token
          </button>
        </div>

        {/* Base URL */}
        <div>
          <label className="block text-xs text-[var(--text-secondary)] mb-1.5">Base URL (region)</label>
          <input
            list="central-regions"
            value={s.centralBaseUrl}
            onChange={(e) => s.updateSettings({ centralBaseUrl: e.target.value })}
            placeholder="https://us4.api.central.arubanetworks.com"
            className={input}
          />
          <datalist id="central-regions">
            {CENTRAL_REGIONS.map((r) => (
              <option key={r} value={r} />
            ))}
          </datalist>
        </div>

        {/* Credentials or token */}
        {s.centralAuthMode === 'token' ? (
          <div>
            <label className="block text-xs text-[var(--text-secondary)] mb-1.5">Access token</label>
            <textarea
              value={s.centralToken}
              onChange={(e) => s.updateSettings({ centralToken: e.target.value })}
              rows={3}
              placeholder="Paste a Central access token (for SSO accounts)…"
              className={`${input} h-auto py-1.5 resize-y`}
            />
            <p className="text-[10px] text-[var(--text-muted)] mt-1">
              For SSO accounts that can't use client-credentials. Not auto-refreshed — re-paste when it expires.
            </p>
          </div>
        ) : (
          <>
            <div className="grid grid-cols-2 gap-2">
              <div>
                <label className="block text-xs text-[var(--text-secondary)] mb-1.5">Client ID</label>
                <input
                  value={s.centralClientId}
                  onChange={(e) => s.updateSettings({ centralClientId: e.target.value })}
                  placeholder="client id"
                  className={input}
                />
              </div>
              <div>
                <label className="block text-xs text-[var(--text-secondary)] mb-1.5">Client Secret</label>
                <input
                  type="password"
                  value={s.centralClientSecret}
                  onChange={(e) => s.updateSettings({ centralClientSecret: e.target.value })}
                  placeholder="client secret"
                  className={input}
                />
              </div>
            </div>
            <p className="text-[10px] text-[var(--text-muted)]">
              OAuth client-credentials. Pick your region's API gateway (us1–us6/eu/apac). Used by the API
              Explorer's "Aruba Central" target.
            </p>
          </>
        )}
      </div>
    </section>
  );
}
