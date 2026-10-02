import { useState } from 'react';
import { invoke } from '@tauri-apps/api/tauri';
import { askConfirm } from '../store/dialogStore';
import { useMcpApprovalStore } from '../store/mcpApprovalStore';
import { notify } from '../store/toastStore';
import type { McpPresetId, McpServerDef, McpStatus, McpWrites } from '../utils/mcpTypes';

/** Forget every "Yes, for this session" answer for a server: its tools must ask again. */
const clearAllowances = (name: string) => useMcpApprovalStore.getState().clearServer(name);

const WRITES_ON_HELP = 'Writes are on. Tools that change things still ask you every time.';
const READ_ONLY_LOGIN = "This login is read-only (checked by the server). Writes can't be turned on here.";
const READ_ONLY_LOGIN_ON =
  'This login is read-only (checked by the server), so changes are blocked anyway. You can still turn writes off.';

/** Presets whose tools are all hidden while writes are off, unless the server marks them read-only. */
const HIDES_UNMARKED: ReadonlySet<McpPresetId> = new Set(['central-mcp-server', 'netmiko-mcp', 'oxidized-librenms']);

/** The help line while writes are off. What happens to command tools depends on the server. Exported for tests. */
export function writesOffHelp(preset: McpPresetId | undefined): string {
  const base = 'Writes are off. Tools that change settings or delete things are hidden from the AI and blocked.';
  if (preset === 'junos-mcp-server') return `${base} Command tools only run show commands.`;
  if (preset === 'hpe-networking-mcp') return `${base} Its invoke_tool and invoke_tools_batch tools are hidden too.`;
  if (preset && HIDES_UNMARKED.has(preset)) {
    return `${base} On this server, every tool it doesn't mark as read-only is hidden too.`;
  }
  if (preset) return `${base} Tools that run commands still ask you every time.`;
  return `${base} Some servers also hide their command tools; the rest ask you every time.`;
}

/** The confirm text before writes go on. Exported for tests. */
export function allowWritesMessage(name: string, status: McpStatus | undefined): string {
  const base = "The AI will see this server's tools that change settings or delete things. Each one still asks you before it runs.";
  const pins = status?.pins;
  if (status?.connected && pins?.kind === 'pinned') {
    return `${base}\n\nGreenCLI will restart ${name} without its read-only settings: ${pins.shown.join(', ')}.`;
  }
  return base;
}

/**
 * The safety strip under one MCP server row: the writes switch, the login and
 * read-only settings GreenCLI sent, notes that need the user (restart, the 1.9
 * upgrade, a preset mismatch) and the Junos plain-show opt-in.
 */
export default function McpServerSafety({
  def,
  status,
  busy,
  onChanged,
  onReconnect,
}: {
  def: McpServerDef;
  status: McpStatus | undefined;
  busy: boolean;
  onChanged: () => void | Promise<void>;
  /** Restarts the server; true when it connected. */
  onReconnect: (name: string) => Promise<boolean>;
}) {
  const [working, setWorking] = useState(false);
  const name = def.name;
  const writes: McpWrites = (status?.writes ?? def.writes) === 'on' ? 'on' : 'off';
  const readOnlyLogin = status?.access === 'read-only';
  const preset = status?.preset ?? null;
  const pins = status?.pins;
  const disabled = busy || working;
  // A read-only login can't turn writes on, but writes that are already on can always go off.
  const lockedOff = readOnlyLogin && writes === 'off';

  const setWrites = async (next: McpWrites) => {
    if (next === 'on') {
      const ok = await askConfirm({
        title: `Allow writes on ${name}?`,
        message: allowWritesMessage(name, status),
        confirmLabel: 'Allow writes',
        cancelLabel: 'Keep writes off',
        danger: true,
      });
      if (!ok) return;
    }
    setWorking(true);
    try {
      await invoke('mcp_set_writes', { name, writes: next });
    } catch (e) {
      notify.error('Could not change writes', String(e));
      setWorking(false);
      await onChanged();
      return;
    }
    clearAllowances(name);
    let restarted = true;
    try {
      // Restart so the server runs with (or without) its read-only settings.
      if (status?.connected) restarted = await onReconnect(name);
    } finally {
      setWorking(false);
    }
    if (!restarted) {
      // The old connection keeps running with the old setting.
      notify.warning(
        `${name} writes setting saved`,
        `Writes are ${next} for the next start, but the restart failed. Restart this server once it can connect.`
      );
    } else if (next === 'on') {
      notify.success(`${name} writes are on`, 'Tools that change things still ask you every time.');
    } else {
      notify.info(`${name} writes are off`, 'Tools that change settings or delete things are hidden from the AI.');
    }
    await onChanged();
  };

  /** The 1.9 upgrade note: saving "off" makes the setting explicit. */
  const acknowledge = async () => {
    try {
      await invoke('mcp_set_writes', { name, writes: 'off' });
    } catch (e) {
      notify.error('Could not change writes', String(e));
    }
    await onChanged();
  };

  const setShowOptIn = async (on: boolean) => {
    try {
      await invoke('mcp_set_show_opt_in', { name, on });
    } catch (e) {
      notify.error('Could not change this setting', String(e));
    }
    clearAllowances(name);
    await onChanged();
  };

  const textButton = 'ml-1.5 text-[var(--accent)] hover:underline disabled:opacity-50';

  return (
    <div className="px-3 pb-2 space-y-1.5 text-[11px]">
      <div>
        <label
          className={`flex items-center gap-2 text-[var(--text-secondary)] select-none ${
            lockedOff || disabled ? 'opacity-70' : 'cursor-pointer'
          }`}
        >
          <input
            type="checkbox"
            checked={writes === 'on'}
            disabled={lockedOff || disabled}
            onChange={(e) => setWrites(e.target.checked ? 'on' : 'off')}
            className="accent-[var(--accent)]"
          />
          Allow writes
        </label>
        <p className="mt-0.5 ml-5 text-[10px] text-[var(--text-muted)] leading-snug">
          {readOnlyLogin
            ? writes === 'on'
              ? READ_ONLY_LOGIN_ON
              : READ_ONLY_LOGIN
            : writes === 'on'
              ? WRITES_ON_HELP
              : writesOffHelp(preset?.id)}
        </p>
      </div>

      {status?.restartNeeded && (
        <p className="text-[var(--accent-warning)] leading-snug">
          Restart this server so its writes setting takes full effect.
          <button type="button" onClick={() => onReconnect(name)} disabled={disabled} className={textButton}>
            Restart
          </button>
        </p>
      )}

      {status?.writesSet === false && (
        <p className="text-[var(--text-secondary)] leading-snug">
          New in 1.9: writes are off for this server. Turn them on if the AI needs to make changes here.
          <button type="button" onClick={acknowledge} disabled={disabled} className={textButton}>
            OK
          </button>
        </p>
      )}

      {writes === 'off' && pins?.kind === 'pinned' && (
        <p className="text-[var(--text-muted)] leading-snug break-words">
          Read-only settings sent: {pins.shown.join(', ')}
          {pins.confirmed ? ' (the server confirmed them)' : ''}
        </p>
      )}
      {writes === 'off' && pins?.kind === 'cannot-pin' && (
        <p className="text-[var(--text-muted)] leading-snug">
          Can&apos;t set this server to read-only ({pins.reason}). GreenCLI still hides and blocks its write tools.
        </p>
      )}

      {status?.access === 'read-only' && <p className="text-[var(--text-muted)]">Login: read-only (checked)</p>}
      {status?.access === 'read-write' && <p className="text-[var(--text-muted)]">Login: can make changes (checked)</p>}

      {preset && status?.presetMismatch === true && (
        <p className="text-[var(--accent-warning)] leading-snug">
          This looks like a {preset.label} server, but its tools don&apos;t match. GreenCLI still hides and blocks
          write tools, but its read-only settings may not apply.
        </p>
      )}

      {preset?.id === 'junos-mcp-server' && (
        <div>
          <label className="flex items-center gap-2 text-[var(--text-secondary)] cursor-pointer select-none">
            <input
              type="checkbox"
              checked={def.showOptIn === true}
              onChange={(e) => setShowOptIn(e.target.checked)}
              className="accent-[var(--accent)]"
            />
            Run plain show commands without asking
          </label>
          <p className="mt-0.5 ml-5 text-[10px] text-[var(--text-muted)] leading-snug">
            Only commands that start with &quot;show&quot; and use safe pipes (match, except, count, display,
            no-more, last, find, trim). Everything else still asks.
          </p>
        </div>
      )}
    </div>
  );
}
