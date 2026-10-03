import { useEffect, useState } from 'react';
import {
  leftoverLine,
  loadSecretStoreStatus,
  MOVE_PENDING_LINE,
  secretStoreLine,
  type SecretStoreStatus,
} from '../utils/secretStore';

/**
 * Says where AI keys and MCP logins are kept (Keychain, Credential Manager,
 * keyring or a private file), plus `after` on the same line. Read again when
 * `refreshKey` changes (e.g. each time Settings opens). With `problemsOnly`,
 * only an old key file left in place and keys not moved yet, or nothing.
 */
export default function SecretStoreNote({
  after,
  refreshKey,
  problemsOnly,
}: {
  after?: string;
  refreshKey?: unknown;
  problemsOnly?: boolean;
}) {
  const [status, setStatus] = useState<SecretStoreStatus | null>(null);

  useEffect(() => {
    let live = true;
    void loadSecretStoreStatus().then((s) => {
      if (live) setStatus(s);
    });
    return () => {
      live = false;
    };
  }, [refreshKey]);

  const problem = status?.kind === 'unavailable';
  if (problemsOnly && !status?.movePending && !status?.leftoverFiles?.length) return null;
  return (
    <div className="text-[10px] mt-1 leading-snug space-y-0.5">
      {!problemsOnly && (
        <p
          data-testid="secret-store-line"
          className={problem ? 'text-[var(--accent-warning)]' : 'text-[var(--text-muted)]'}
        >
          {secretStoreLine(status)}
          {after ? ` ${after}` : ''}
        </p>
      )}
      {status?.movePending && <p className="text-[var(--accent-warning)]">{MOVE_PENDING_LINE}</p>}
      {(status?.leftoverFiles ?? []).map((path) => (
        <p key={path} className="text-[var(--accent-warning)] break-all">
          {leftoverLine(path)}
        </p>
      ))}
    </div>
  );
}
