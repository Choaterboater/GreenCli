import { useEffect, useMemo, useState } from 'react';
import { X, Plug, Monitor, Server, Wifi, RadioTower, Cloud, Network, TerminalSquare, FolderOpen } from 'lucide-react';
import { open as openDialog } from '@tauri-apps/api/dialog';
import { useSessionStore } from '../store/sessionStore';
import {
  ConnectionConfig,
  Protocol,
  DeviceType,
  PROTOCOLS,
  DEVICE_TYPES,
  LOCAL_CLI_PRESETS,
  deviceMeta,
  vendorColor,
} from '../types';
import { generateId } from '../utils';
import { invoke } from '@tauri-apps/api/tauri';
import { notify } from '../store/toastStore';
import { useSettingsStore } from '../store/settingsStore';
import { allDeviceProfiles, profileForDeviceType, saveSessionPayload } from '../utils/deviceProfiles';

const LUCIDE: Record<string, typeof Monitor> = { Network, Wifi, RadioTower, Server, Cloud, Monitor };

function DeviceGlyph({ deviceType, size = 16 }: { deviceType: string; size?: number }) {
  const Ico = LUCIDE[deviceMeta(deviceType).icon] ?? Monitor;
  return <Ico size={size} />;
}

interface QuickConnectProps {
  onConnect: (config: ConnectionConfig) => void;
}

export default function QuickConnect({ onConnect }: QuickConnectProps) {
  const { showQuickConnect, setShowQuickConnect } = useSessionStore();
  const settings = useSettingsStore();
  const profiles = useMemo(
    () => allDeviceProfiles(settings.customDeviceProfiles),
    [settings.customDeviceProfiles],
  );
  const [protocol, setProtocol] = useState<Protocol>('ssh');
  const [host, setHost] = useState('');
  const [port, setPort] = useState(22);
  const [username, setUsername] = useState('');
  const [deviceType, setDeviceType] = useState<DeviceType>('generic');
  const [deviceProfileId, setDeviceProfileId] = useState('builtin-generic');
  const [serialPort, setSerialPort] = useState('');
  const [baudRate, setBaudRate] = useState(9600);
  const [dataBits, setDataBits] = useState(8);
  const [parity, setParity] = useState('none');
  const [stopBits, setStopBits] = useState(1);
  const [startupCommands, setStartupCommands] = useState('');
  const [cliPresetId, setCliPresetId] = useState('shell');
  const [customCommand, setCustomCommand] = useState('');
  // Working directory the local shell/CLI starts in (empty => home/default).
  const [cwd, setCwd] = useState('');
  const [showJump, setShowJump] = useState(false);
  const [jumpHost, setJumpHost] = useState('');
  const [jumpPort, setJumpPort] = useState(22);
  const [jumpUsername, setJumpUsername] = useState('');
  const [jumpPassword, setJumpPassword] = useState('');
  const [saveSession, setSaveSession] = useState(false);
  const [connecting, setConnecting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const lastUsedProfile = () =>
    profiles.find((profile) => profile.id === settings.lastUsedDeviceProfileId) ??
    profileForDeviceType(settings.lastUsedDeviceType);

  useEffect(() => {
    if (!showQuickConnect) return;
    const profile = lastUsedProfile();
    setDeviceType(profile.deviceType);
    setDeviceProfileId(profile.id);
  }, [showQuickConnect, settings.lastUsedDeviceType, settings.lastUsedDeviceProfileId, profiles]);

  if (!showQuickConnect) return null;

  const isHostBased = protocol === 'ssh' || protocol === 'telnet';

  const resetForm = () => {
    setProtocol('ssh');
    setHost('');
    setPort(22);
    setUsername('');
    const profile = lastUsedProfile();
    setDeviceType(profile.deviceType);
    setDeviceProfileId(profile.id);
    setSerialPort('');
    setBaudRate(9600);
    setDataBits(8);
    setParity('none');
    setStopBits(1);
    setStartupCommands('');
    setCliPresetId('shell');
    setCustomCommand('');
    setCwd('');
    setShowJump(false);
    setJumpHost('');
    setJumpPort(22);
    setJumpUsername('');
    setJumpPassword('');
    setSaveSession(false);
    setError(null);
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setConnecting(true);

    try {
      const preset = LOCAL_CLI_PRESETS.find((p) => p.id === cliPresetId);
      const localCommand = protocol === 'local' ? customCommand.trim() || preset?.command : undefined;
      const localName =
        protocol === 'local'
          ? customCommand.trim() ||
            (preset && preset.id !== 'shell' ? preset.label : localCommand || 'Local Shell')
          : undefined;

      const config: ConnectionConfig = {
        id: generateId(),
        name: localName || host || serialPort || 'New Session',
        protocol,
        host: isHostBased ? host : undefined,
        port: isHostBased ? port : undefined,
        username: isHostBased ? username : undefined,
        serialPort: protocol === 'serial' ? serialPort : undefined,
        baudRate: protocol === 'serial' ? baudRate : undefined,
        dataBits: protocol === 'serial' ? dataBits : undefined,
        parity: protocol === 'serial' ? parity : undefined,
        stopBits: protocol === 'serial' ? stopBits : undefined,
        startupCommands: startupCommands.trim() || undefined,
        deviceType: protocol === 'local' ? 'generic' : deviceType,
        deviceProfileId: protocol === 'local' ? 'builtin-generic' : deviceProfileId,
        command: localCommand,
        args: protocol === 'local' ? preset?.args : undefined,
        cwd: protocol === 'local' && cwd.trim() ? cwd.trim() : undefined,
        jumpHost: protocol === 'ssh' && showJump && jumpHost ? jumpHost : undefined,
        jumpPort: protocol === 'ssh' && showJump && jumpHost ? jumpPort : undefined,
        jumpUsername: protocol === 'ssh' && showJump && jumpHost ? jumpUsername : undefined,
        jumpPassword: protocol === 'ssh' && showJump && jumpHost ? jumpPassword : undefined,
      };
      if (protocol !== 'local') {
        settings.setLastUsedDeviceType(config.deviceType);
        settings.setLastUsedDeviceProfileId(config.deviceProfileId || 'builtin-generic');
      }

      if (saveSession) {
        const saved = await invoke('save_session', {
          config: saveSessionPayload(config),
          folderId: 'default',
        })
          .then(() => true)
          .catch(() => false);
        if (saved) {
          // Mirror the sidebar item to what the backend persists: NO secrets
          // (passwords/keys are never written to sessions.json), so the in-memory
          // item matches the stored record and can't leak credentials.
          const { password, jumpPassword, privateKey, keyPassphrase, ...safe } = config;
          void password;
          void jumpPassword;
          void privateKey;
          void keyPassphrase;
          useSessionStore.getState().addSessionToFolder('default', safe as ConnectionConfig);
        } else {
          notify.error('Could not save session', 'It was not added to the sidebar.');
        }
      }

      await onConnect(config);
      setShowQuickConnect(false);
      resetForm();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setConnecting(false);
    }
  };

  const handleProtocolChange = (p: Protocol) => {
    setProtocol(p);
    setPort(p === 'ssh' ? 22 : p === 'telnet' ? 23 : 9600);
  };

  const chooseProfile = (profileId: string) => {
    const profile = profiles.find((p) => p.id === profileId) ?? profiles[0];
    setDeviceProfileId(profile.id);
    setDeviceType(profile.deviceType);
    settings.setLastUsedDeviceType(profile.deviceType);
    settings.setLastUsedDeviceProfileId(profile.id);
  };

  const inputCls = 'input-field w-full h-9 px-3 text-sm';

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center modal-backdrop animate-fade-in"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) setShowQuickConnect(false);
      }}
    >
      <div className="surface-elevated w-[500px] max-w-[94vw] max-h-[92vh] overflow-y-auto animate-scale-in">
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-4 border-b border-[var(--border)]">
          <div className="flex items-center gap-2.5">
            <div
              className="flex items-center justify-center w-7 h-7 rounded-md"
              style={{ background: 'var(--accent-soft)' }}
            >
              <Plug size={15} style={{ color: 'var(--accent)' }} />
            </div>
            <h2 className="text-[16px] font-semibold text-[var(--text-primary)]">Quick Connect</h2>
          </div>
          <button
            onClick={() => setShowQuickConnect(false)}
            className="p-1.5 rounded-md hover:bg-[var(--bg-tertiary)] text-[var(--text-secondary)] hover:text-[var(--text-primary)] transition-colors"
          >
            <X size={18} />
          </button>
        </div>

        {/* Form */}
        <form onSubmit={handleSubmit} className="px-5 py-4 space-y-4">
          {/* Protocol */}
          <div>
            <label className="block text-[11px] font-semibold uppercase tracking-wide text-[var(--text-secondary)] mb-1.5">
              Protocol
            </label>
            <div className="flex gap-2">
              {PROTOCOLS.map((p) => (
                <button
                  key={p.value}
                  type="button"
                  onClick={() => handleProtocolChange(p.value)}
                  className={`flex-1 py-2 text-sm rounded-[var(--radius)] border transition-all ${
                    protocol === p.value
                      ? 'border-[var(--accent)] text-[var(--accent)] bg-[var(--accent-soft)] font-medium'
                      : 'bg-[var(--bg-inset)] border-[var(--border)] text-[var(--text-secondary)] hover:border-[var(--border-strong)] hover:text-[var(--text-primary)]'
                  }`}
                >
                  {p.label}
                </button>
              ))}
            </div>
          </div>

          {/* Host / Serial */}
          <div className="grid grid-cols-3 gap-3">
            {isHostBased ? (
              <>
                <div className="col-span-2">
                  <label className="block text-[11px] font-semibold uppercase tracking-wide text-[var(--text-secondary)] mb-1.5">
                    Host
                  </label>
                  <input
                    type="text"
                    value={host}
                    onChange={(e) => setHost(e.target.value)}
                    placeholder="192.168.1.1"
                    required
                    className={inputCls}
                  />
                </div>
                <div>
                  <label className="block text-[11px] font-semibold uppercase tracking-wide text-[var(--text-secondary)] mb-1.5">
                    Port
                  </label>
                  <input
                    type="number"
                    value={port}
                    // Clearing the field makes Number('') = 0, which submit()
                    // would send verbatim as a guaranteed-failing port 0 — fall
                    // back to the last valid value instead of accepting it.
                    onChange={(e) => setPort(Math.min(65535, Math.max(1, Number(e.target.value) || port)))}
                    min={1}
                    max={65535}
                    className={inputCls}
                  />
                </div>
              </>
            ) : protocol === 'serial' ? (
              <>
                <div className="col-span-2">
                  <label className="block text-[11px] font-semibold uppercase tracking-wide text-[var(--text-secondary)] mb-1.5">
                    Serial Port
                  </label>
                  <input
                    type="text"
                    value={serialPort}
                    onChange={(e) => setSerialPort(e.target.value)}
                    placeholder="/dev/ttyUSB0"
                    required
                    className={inputCls}
                  />
                </div>
                <div>
                  <label className="block text-[11px] font-semibold uppercase tracking-wide text-[var(--text-secondary)] mb-1.5">
                    Baud
                  </label>
                  <select
                    value={baudRate}
                    onChange={(e) => setBaudRate(Number(e.target.value))}
                    className={inputCls}
                  >
                    <option value={9600}>9600</option>
                    <option value={19200}>19200</option>
                    <option value={38400}>38400</option>
                    <option value={57600}>57600</option>
                    <option value={115200}>115200</option>
                  </select>
                </div>
              </>
            ) : null}
          </div>

          {/* Serial line settings */}
          {protocol === 'serial' && (
            <div className="grid grid-cols-3 gap-3">
              <div>
                <label className="block text-[11px] font-semibold uppercase tracking-wide text-[var(--text-secondary)] mb-1.5">Data bits</label>
                <select value={dataBits} onChange={(e) => setDataBits(Number(e.target.value))} className={inputCls}>
                  {[8, 7, 6, 5].map((d) => (<option key={d} value={d}>{d}</option>))}
                </select>
              </div>
              <div>
                <label className="block text-[11px] font-semibold uppercase tracking-wide text-[var(--text-secondary)] mb-1.5">Parity</label>
                <select value={parity} onChange={(e) => setParity(e.target.value)} className={inputCls}>
                  <option value="none">None</option>
                  <option value="even">Even</option>
                  <option value="odd">Odd</option>
                </select>
              </div>
              <div>
                <label className="block text-[11px] font-semibold uppercase tracking-wide text-[var(--text-secondary)] mb-1.5">Stop bits</label>
                <select value={stopBits} onChange={(e) => setStopBits(Number(e.target.value))} className={inputCls}>
                  <option value={1}>1</option>
                  <option value={2}>2</option>
                </select>
              </div>
            </div>
          )}

          {/* Local CLI */}
          {protocol === 'local' && (
            <div className="space-y-3">
              <div>
                <label className="block text-[11px] font-semibold uppercase tracking-wide text-[var(--text-secondary)] mb-1.5">
                  Launch
                </label>
                <div className="grid grid-cols-4 gap-2">
                  {LOCAL_CLI_PRESETS.map((p) => (
                    <button
                      key={p.id}
                      type="button"
                      onClick={() => {
                        setCliPresetId(p.id);
                        setCustomCommand('');
                      }}
                      className={`flex flex-col items-center gap-1 py-2.5 rounded-[var(--radius)] border transition-all ${
                        cliPresetId === p.id && !customCommand
                          ? 'border-[var(--accent)] text-[var(--accent)] bg-[var(--accent-soft)]'
                          : 'bg-[var(--bg-inset)] border-[var(--border)] text-[var(--text-secondary)] hover:border-[var(--border-strong)]'
                      }`}
                    >
                      <TerminalSquare size={16} />
                      <span className="text-[10px] font-medium">{p.label}</span>
                    </button>
                  ))}
                </div>
              </div>
              <div>
                <label className="block text-[11px] font-semibold uppercase tracking-wide text-[var(--text-secondary)] mb-1.5">
                  Custom command (optional)
                </label>
                <input
                  type="text"
                  value={customCommand}
                  onChange={(e) => setCustomCommand(e.target.value)}
                  placeholder="e.g. gh copilot — overrides the preset above"
                  className={inputCls}
                />
              </div>
              <div>
                <label className="block text-[11px] font-semibold uppercase tracking-wide text-[var(--text-secondary)] mb-1.5">
                  Start folder (optional)
                </label>
                <div className="flex gap-2">
                  <input
                    type="text"
                    value={cwd}
                    onChange={(e) => setCwd(e.target.value)}
                    placeholder={'e.g. C:\\Projects  or  /Users/me/code'}
                    className={`${inputCls} flex-1 font-mono`}
                  />
                  <button
                    type="button"
                    onClick={async () => {
                      try {
                        const dir = await openDialog({
                          directory: true,
                          multiple: false,
                          title: 'Choose start folder',
                          defaultPath: cwd.trim() || undefined,
                        });
                        if (typeof dir === 'string') setCwd(dir);
                      } catch {
                        /* native dialog unavailable (e.g. browser mode) — keep manual entry */
                      }
                    }}
                    className="flex items-center gap-1.5 h-9 px-3 text-sm rounded-[var(--radius)] bg-[var(--bg-tertiary)] hover:bg-[var(--border-strong)] text-[var(--text-primary)] transition-colors flex-shrink-0"
                    title="Browse for a folder"
                  >
                    <FolderOpen size={15} />
                    Browse
                  </button>
                </div>
                <p className="text-[10px] text-[var(--text-muted)] mt-1">
                  The shell starts in this directory. Leave blank to use your home/default.
                </p>
              </div>
            </div>
          )}

          {/* Username */}
          {isHostBased && (
            <div>
              <label className="block text-[11px] font-semibold uppercase tracking-wide text-[var(--text-secondary)] mb-1.5">
                Username
              </label>
              <input
                type="text"
                value={username}
                onChange={(e) => setUsername(e.target.value)}
                placeholder="admin"
                className={inputCls}
              />
            </div>
          )}

          {/* Jump host */}
          {protocol === 'ssh' && (
            <div>
              <button
                type="button"
                onClick={() => setShowJump((v) => !v)}
                className="text-xs font-medium text-[var(--text-secondary)] hover:text-[var(--text-primary)]"
              >
                {showJump ? '▾' : '▸'} Jump host / bastion (optional)
              </button>
              {showJump && (
                <div className="mt-2 space-y-2 p-2.5 bg-[var(--bg-inset)] border border-[var(--border)] rounded-[var(--radius)]">
                  <div className="grid grid-cols-3 gap-2">
                    <input
                      value={jumpHost}
                      onChange={(e) => setJumpHost(e.target.value)}
                      placeholder="Jump host"
                      className="input-field col-span-2 h-8 px-2 text-xs"
                    />
                    <input
                      type="number"
                      value={jumpPort}
                      onChange={(e) => setJumpPort(Math.min(65535, Math.max(1, Number(e.target.value) || jumpPort)))}
                      placeholder="22"
                      className="input-field h-8 px-2 text-xs"
                    />
                  </div>
                  <div className="grid grid-cols-2 gap-2">
                    <input
                      value={jumpUsername}
                      onChange={(e) => setJumpUsername(e.target.value)}
                      placeholder="Jump username"
                      className="input-field h-8 px-2 text-xs"
                    />
                    <input
                      type="password"
                      value={jumpPassword}
                      onChange={(e) => setJumpPassword(e.target.value)}
                      placeholder="Jump password"
                      className="input-field h-8 px-2 text-xs"
                    />
                  </div>
                  <p className="text-[10px] text-[var(--text-muted)]">
                    Connect to the target through this bastion (ProxyJump). Password auth.
                  </p>
                </div>
              )}
            </div>
          )}

          {/* Device type */}
          {protocol !== 'local' && (
            <div>
              <label className="block text-[11px] font-semibold uppercase tracking-wide text-[var(--text-secondary)] mb-1.5">
                Device Type
              </label>
              <div className="grid grid-cols-4 gap-2">
                {profiles.map((profile) => {
                  const active = deviceProfileId === profile.id || (!deviceProfileId && deviceType === profile.deviceType);
                  const color = profile.color || vendorColor(profile.deviceType);
                  return (
                    <button
                      key={profile.id}
                      type="button"
                      onClick={() => chooseProfile(profile.id)}
                      title={profile.name}
                      className={`flex flex-col items-center gap-1 py-2.5 rounded-[var(--radius)] border transition-all ${
                        active
                          ? 'bg-[var(--bg-tertiary)]'
                          : 'bg-[var(--bg-inset)] border-[var(--border)] text-[var(--text-secondary)] hover:border-[var(--border-strong)]'
                      }`}
                      style={active ? { borderColor: color, color } : undefined}
                    >
                      <span style={{ color }}>
                        <DeviceGlyph deviceType={profile.deviceType} />
                      </span>
                      <span className="text-[10px] font-semibold">{profile.short}</span>
                    </button>
                  );
                })}
              </div>
            </div>
          )}

          {/* Startup commands (run after connect) */}
          {protocol !== 'local' && (
            <div>
              <label className="block text-[11px] font-semibold uppercase tracking-wide text-[var(--text-secondary)] mb-1.5">
                Startup commands (optional)
              </label>
              <textarea
                value={startupCommands}
                onChange={(e) => setStartupCommands(e.target.value)}
                rows={2}
                placeholder={'One per line, run on connect — e.g.\nterminal length 0\nno page'}
                className="input-field w-full px-3 py-2 text-xs font-mono resize-y"
              />
            </div>
          )}

          {/* Save */}
          <label className="flex items-center gap-2 cursor-pointer select-none">
            <input
              type="checkbox"
              checked={saveSession}
              onChange={(e) => setSaveSession(e.target.checked)}
              className="w-4 h-4 rounded"
            />
            <span className="text-sm text-[var(--text-secondary)]">Save to Sidebar</span>
          </label>

          {/* Error */}
          {error && (
            <div className="px-3 py-2 rounded-[var(--radius)] text-sm" style={{ background: 'rgba(240,83,63,0.12)', color: 'var(--accent-danger)', border: '1px solid rgba(240,83,63,0.3)' }}>
              {error}
            </div>
          )}

          {/* Actions */}
          <div className="flex items-center gap-3 pt-1">
            <button
              type="button"
              onClick={() => setShowQuickConnect(false)}
              className="flex-1 h-10 text-sm rounded-[var(--radius)] bg-[var(--bg-tertiary)] hover:bg-[var(--border-strong)] text-[var(--text-primary)] transition-colors"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={connecting || (isHostBased && !host) || (protocol === 'serial' && !serialPort)}
              className="btn-accent flex-1 flex items-center justify-center gap-2 h-10 text-sm disabled:opacity-50 disabled:cursor-not-allowed"
            >
              <Plug size={15} />
              {connecting ? 'Connecting…' : 'Connect'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
