import { useEffect, useState } from 'react';
import { RefreshCw } from 'lucide-react';
import {
  UPDATE_TEXT,
  checkForUpdate,
  dailyCheckOn,
  getUpdateStatus,
  offText,
  restartToUpdate,
  setDailyCheck,
  updateErrorText,
  type UpdateStatus,
} from '../utils/updates';

type CheckState =
  | { kind: 'idle' }
  | { kind: 'checking' }
  | { kind: 'latest' }
  | { kind: 'ready'; version: string }
  | { kind: 'error'; message: string };

const isWindows = typeof navigator !== 'undefined' && /Windows/i.test(navigator.userAgent);

/** Settings → Updates: version, Check for updates, Restart to update, daily check. */
export default function UpdateSettings() {
  const [status, setStatus] = useState<UpdateStatus | null>(null);
  const [check, setCheck] = useState<CheckState>({ kind: 'idle' });
  const [daily, setDaily] = useState(dailyCheckOn);

  useEffect(() => {
    let alive = true;
    getUpdateStatus()
      .then((s) => {
        if (!alive) return;
        setStatus(s);
        if (s?.ready) setCheck({ kind: 'ready', version: s.ready });
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, []);

  const off = offText(status);
  const moved = status && status.place !== 'normal';

  const runCheck = async () => {
    setCheck({ kind: 'checking' });
    try {
      const version = await checkForUpdate();
      setCheck(version ? { kind: 'ready', version } : { kind: 'latest' });
    } catch (e) {
      setCheck({ kind: 'error', message: updateErrorText(e) });
    }
  };

  const button =
    'flex items-center gap-1.5 px-3 h-8 rounded bg-[var(--bg-tertiary)] hover:bg-[var(--border-strong)] disabled:opacity-50 text-xs text-[var(--text-primary)]';

  return (
    <section id="set-updates">
      <h3 className="text-sm font-semibold text-[var(--text-primary)] mb-2">Updates</h3>
      <p className="text-xs text-[var(--text-muted)] mb-3">{UPDATE_TEXT.how}</p>
      {status && <p className="text-sm text-[var(--text-primary)] mb-3">Version {status.version}</p>}
      <div className="flex flex-wrap items-center gap-2 mb-3">
        <button onClick={runCheck} disabled={!!off || check.kind === 'checking'} className={button}>
          <RefreshCw size={13} />
          {check.kind === 'checking' ? 'Checking…' : 'Check for updates'}
        </button>
        {check.kind === 'ready' && (
          <button
            onClick={() => void restartToUpdate(check.version)}
            disabled={!!moved}
            className="flex items-center gap-1.5 px-3 h-8 rounded bg-[var(--accent)] hover:bg-[var(--accent-hover)] disabled:opacity-50 text-xs text-[var(--accent-fg)]"
          >
            {UPDATE_TEXT.restart}
          </button>
        )}
        <span className="text-xs text-[var(--text-secondary)]" role="status">
          {check.kind === 'latest' && UPDATE_TEXT.latest}
          {check.kind === 'ready' && UPDATE_TEXT.ready(check.version)}
          {check.kind === 'error' && check.message}
        </span>
      </div>
      {off ? (
        <p className="text-xs text-[var(--text-muted)]">{off}</p>
      ) : (
        <>
          <label className="flex items-center gap-2 text-xs text-[var(--text-primary)] mb-2">
            <input
              type="checkbox"
              checked={daily}
              onChange={(e) => {
                setDaily(e.target.checked);
                setDailyCheck(e.target.checked);
              }}
            />
            Check once a day
          </label>
          {moved && <p className="text-xs text-[var(--accent-warning)]">{UPDATE_TEXT.moveFirst}</p>}
          {isWindows && <p className="text-xs text-[var(--text-muted)]">{UPDATE_TEXT.windows}</p>}
        </>
      )}
    </section>
  );
}
