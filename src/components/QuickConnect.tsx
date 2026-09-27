import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  X,
  Plug,
  Monitor,
  Server,
  Wifi,
  RadioTower,
  Cloud,
  Network,
  TerminalSquare,
  FolderOpen,
  RefreshCw,
  Save,
} from 'lucide-react';
import { open as openDialog } from '@tauri-apps/api/dialog';
import { useSessionStore } from '../store/sessionStore';
import { savedHostId } from '../utils/tabs';
import {
  ConnectionConfig,
  LoginProfile,
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
import { defaultBaudRate, parseHostSpec, rankSerialPorts } from '../utils/hosts';
import { effectiveLogin, PER_HOST_PASSWORD } from '../utils/logins';
import { jumpCredentialKey } from '../utils/connect';
import { saveToVault } from '../utils/vaultAccess';

const LUCIDE: Record<string, typeof Monitor> = { Network, Wifi, RadioTower, Server, Cloud, Monitor };

// What a console port is called on this OS — the old Linux-only hint
// (/dev/ttyUSB0) meant nothing to Windows or Mac users.
const PLATFORM = typeof navigator !== 'undefined' ? navigator.platform.toUpperCase() : '';
const SERIAL_PLACEHOLDER = PLATFORM.includes('WIN')
  ? 'COM3'
  : PLATFORM.includes('MAC')
    ? '/dev/cu.usbserial-…'
    : '/dev/ttyUSB0';
const CUSTOM_SERIAL = '__custom__';
const NO_LOGINS: LoginProfile[] = [];

function DeviceGlyph({ deviceType, size = 16 }: { deviceType: string; size?: number }) {
  const Ico = LUCIDE[deviceMeta(deviceType).icon] ?? Monitor;
  return <Ico size={size} />;
}

interface QuickConnectProps {
  onConnect: (config: ConnectionConfig) => void;
}

export default function QuickConnect({ onConnect }: QuickConnectProps) {
  // Narrow per-field selectors instead of whole-store subscriptions.
  const showQuickConnect = useSessionStore((s) => s.showQuickConnect);
  const setShowQuickConnect = useSessionStore((s) => s.setShowQuickConnect);
  const quickConnectDraft = useSessionStore((s) => s.quickConnectDraft);
  const editing = quickConnectDraft?.editing;
  const customDeviceProfiles = useSettingsStore((s) => s.customDeviceProfiles);
  const lastUsedDeviceType = useSettingsStore((s) => s.lastUsedDeviceType);
  const lastUsedDeviceProfileId = useSettingsStore((s) => s.lastUsedDeviceProfileId);
  const setLastUsedDeviceType = useSettingsStore((s) => s.setLastUsedDeviceType);
  const setLastUsedDeviceProfileId = useSettingsStore((s) => s.setLastUsedDeviceProfileId);
  const lastUsedSshUsername = useSettingsStore((s) => s.lastUsedSshUsername);
  const setLastUsedSshUsername = useSettingsStore((s) => s.setLastUsedSshUsername);
  const loginProfiles = useSettingsStore((s) => s.loginProfiles) ?? NO_LOGINS;
  const folders = useSessionStore((s) => s.folders);
  const profiles = useMemo(
    () => allDeviceProfiles(customDeviceProfiles),
    [customDeviceProfiles],
  );
  const [protocol, setProtocol] = useState<Protocol>('ssh');
  const [host, setHost] = useState('');
  const [port, setPort] = useState(22);
  const [username, setUsername] = useState('');
  const [deviceType, setDeviceType] = useState<DeviceType>('generic');
  const [deviceProfileId, setDeviceProfileId] = useState('builtin-generic');
  const [serialPort, setSerialPort] = useState('');
  const [baudRate, setBaudRate] = useState(9600);
  // Once the user picks a speed, a device-type change must not overwrite it.
  const [baudTouched, setBaudTouched] = useState(false);
  // null = not scanned yet. Custom = the port isn't in the list (typed by hand).
  const [serialPorts, setSerialPorts] = useState<string[] | null>(null);
  const [customSerial, setCustomSerial] = useState(false);
  const [scanningPorts, setScanningPorts] = useState(false);
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
  // Shared logins: '' = the folder's default (host) / key or agent (jump),
  // PER_HOST_PASSWORD = its own saved password, else a LoginProfile id. A new
  // jump host starts on "Password", like the old always-there password box.
  const [loginChoice, setLoginChoice] = useState('');
  const [jumpLogin, setJumpLogin] = useState(PER_HOST_PASSWORD);
  const [saveSession, setSaveSession] = useState(false);
  const [connecting, setConnecting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const lastUsedProfile = () =>
    profiles.find((profile) => profile.id === lastUsedDeviceProfileId) ??
    profileForDeviceType(lastUsedDeviceType);

  useEffect(() => {
    // An edit shows the saved host's own profile (applied below), not the last-used one.
    if (!showQuickConnect || editing) return;
    const profile = lastUsedProfile();
    setDeviceType(profile.deviceType);
    setDeviceProfileId(profile.id);
  }, [showQuickConnect, editing, lastUsedDeviceType, lastUsedDeviceProfileId, profiles]);

  // Console speed follows the device family (AOS-CX 115200, others 9600)
  // until the user picks one themselves.
  useEffect(() => {
    if (!baudTouched) setBaudRate(defaultBaudRate(deviceType));
  }, [deviceType, baudTouched]);

  // SSH needs a username; prefill the last one used rather than leave a blank
  // that looks filled in (the old grey "admin" placeholder) and logs in as nobody.
  useEffect(() => {
    if (showQuickConnect && !editing && protocol === 'ssh') {
      setUsername((current) => current || (lastUsedSshUsername ?? ''));
    }
  }, [showQuickConnect, editing, protocol, lastUsedSshUsername]);

  const loadSerialPorts = useCallback(async () => {
    setScanningPorts(true);
    try {
      const { ordered, preferred } = rankSerialPorts((await invoke<string[]>('list_serial_ports')) ?? []);
      setSerialPorts(ordered);
      // Keep a port the user already chose; otherwise take the one obvious cable.
      setSerialPort((current) => current || preferred || '');
    } catch {
      setSerialPorts([]);
    } finally {
      setScanningPorts(false);
    }
  }, []);

  useEffect(() => {
    if (showQuickConnect && protocol === 'serial') void loadSerialPorts();
  }, [showQuickConnect, protocol, loadSerialPorts]);

  const resetForm = () => {
    setProtocol('ssh');
    setHost('');
    setPort(22);
    setUsername('');
    const profile = lastUsedProfile();
    setDeviceType(profile.deviceType);
    setDeviceProfileId(profile.id);
    setSerialPort('');
    setCustomSerial(false);
    setBaudTouched(false);
    setBaudRate(defaultBaudRate(profile.deviceType));
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
    setLoginChoice('');
    setJumpLogin(PER_HOST_PASSWORD);
    setSaveSession(false);
    setError(null);
  };

  // Fill the form once per opening from a draft: "Edit…" on a saved host, or
  // the sidebar's "Add a host" (Save to Sidebar pre-ticked).
  const filledFromDraftRef = useRef(false);
  useEffect(() => {
    if (!showQuickConnect || !quickConnectDraft) return;
    filledFromDraftRef.current = true;
    setSaveSession(!!quickConnectDraft.save);
    const cfg = quickConnectDraft.editing?.config;
    if (!cfg) return;
    setProtocol(cfg.protocol);
    setHost(cfg.host ?? '');
    setPort(cfg.port ?? (cfg.protocol === 'telnet' ? 23 : 22));
    setUsername(cfg.username ?? '');
    setDeviceType(cfg.deviceType);
    setDeviceProfileId(
      profiles.find((p) => p.id === cfg.deviceProfileId)?.id ?? profileForDeviceType(cfg.deviceType).id
    );
    setSerialPort(cfg.serialPort ?? '');
    setCustomSerial(false);
    setBaudTouched(cfg.baudRate != null);
    setBaudRate(cfg.baudRate ?? defaultBaudRate(cfg.deviceType));
    setDataBits(cfg.dataBits ?? 8);
    setParity(cfg.parity ?? 'none');
    setStopBits(cfg.stopBits ?? 1);
    setStartupCommands(cfg.startupCommands ?? '');
    const preset = LOCAL_CLI_PRESETS.find((p) => p.command === cfg.command);
    setCliPresetId(preset?.id ?? 'shell');
    setCustomCommand(preset ? '' : cfg.command ?? '');
    setCwd(cfg.cwd ?? '');
    setShowJump(!!cfg.jumpHost);
    setJumpHost(cfg.jumpHost ?? '');
    setJumpPort(cfg.jumpPort ?? 22);
    setJumpUsername(cfg.jumpUsername ?? '');
    setJumpPassword('');
    setLoginChoice(cfg.loginProfileId ?? '');
    // A saved jump host with no login choice predates them: it only ever used
    // its key / agent. Adding a new jump host starts on "Password".
    setJumpLogin(cfg.jumpLoginProfileId ?? (cfg.jumpHost ? '' : PER_HOST_PASSWORD));
    setError(null);
    // Once per opening — re-running on a profile change would undo the user's edits.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [showQuickConnect, quickConnectDraft]);

  // Clear host/credential fields when the dialog closes. The component stays
  // mounted (App renders it unconditionally; close = `return null` below), so
  // without this the previous host/username/jump password would reappear on
  // reopen and could be sent to a different host.
  const wasOpenRef = useRef(showQuickConnect);
  useEffect(() => {
    if (wasOpenRef.current && !showQuickConnect && filledFromDraftRef.current) {
      // A saved host's serial/jump/startup settings must not carry into the
      // next plain Quick Connect either.
      filledFromDraftRef.current = false;
      resetForm();
    } else if (wasOpenRef.current && !showQuickConnect) {
      setHost('');
      setUsername('');
      setJumpHost('');
      setJumpUsername('');
      setJumpPassword('');
      setLoginChoice('');
      setJumpLogin(PER_HOST_PASSWORD);
      setError(null);
    }
    wasOpenRef.current = showQuickConnect;
    // Only the open→closed edge matters; resetForm is recreated every render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [showQuickConnect]);

  if (!showQuickConnect) return null;

  const isHostBased = protocol === 'ssh' || protocol === 'telnet';
  // What Connect would use right now, counting a "user@" still in the Host box.
  const hostSpec = parseHostSpec(host);
  // The shared login this host would use: its own pick, else the default of
  // the folder it's saved in (an unsaved connect has no folder).
  const targetFolder = folders.find(
    (f) => f.id === (editing ? editing.folderId : saveSession ? 'default' : undefined)
  );
  const folderLogin = loginProfiles.find((p) => p.id === targetFolder?.loginProfileId);
  const passwordAuth = (editing?.config.authType ?? 'password') === 'password';
  const login = effectiveLogin(
    { protocol, authType: editing?.config.authType, loginProfileId: loginChoice || undefined },
    targetFolder?.loginProfileId,
    loginProfiles
  )?.profile;
  const missingSshUser =
    protocol === 'ssh' && !username.trim() && !hostSpec.user && !login?.username;
  const serialChoices = serialPorts ?? [];
  const typingSerial =
    customSerial || serialChoices.length === 0 || (!!serialPort && !serialChoices.includes(serialPort));

  // "admin@10.0.0.1:2222" typed or pasted into Host also fills Username and
  // Port — it's the form people copy from ssh commands and ticket notes.
  const applyHostSpec = () => {
    const next = { host: hostSpec.host, username: hostSpec.user ?? username.trim(), port: hostSpec.port ?? port };
    setHost(next.host);
    if (hostSpec.user) setUsername(hostSpec.user);
    if (hostSpec.port) setPort(hostSpec.port);
    return next;
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setConnecting(true);

    try {
      const target = isHostBased ? applyHostSpec() : undefined;
      const preset = LOCAL_CLI_PRESETS.find((p) => p.id === cliPresetId);
      const localCommand = protocol === 'local' ? customCommand.trim() || preset?.command : undefined;
      const localName =
        protocol === 'local'
          ? customCommand.trim() ||
            (preset && preset.id !== 'shell' ? preset.label : localCommand || 'Local Shell')
          : undefined;

      const config: ConnectionConfig = {
        id: generateId(),
        name: localName || target?.host || serialPort.trim() || 'New Session',
        protocol,
        host: target?.host,
        port: target?.port,
        username: target?.username,
        serialPort: protocol === 'serial' ? serialPort.trim() : undefined,
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
        // Only the "Password" choice takes a typed one; a shared login reads its own.
        jumpPassword:
          protocol === 'ssh' && showJump && jumpHost && jumpLogin === PER_HOST_PASSWORD
            ? jumpPassword
            : undefined,
        loginProfileId: protocol === 'ssh' && loginChoice ? loginChoice : undefined,
        jumpLoginProfileId: protocol === 'ssh' && showJump && jumpHost && jumpLogin ? jumpLogin : undefined,
      };

      // A saved host's jump password goes to the vault, never sessions.json —
      // before, it was dropped on save, so saved hosts behind a password-only
      // bastion could never log in again.
      const saveJumpPassword = async () => {
        if (!(editing || saveSession) || config.jumpLoginProfileId !== PER_HOST_PASSWORD) return;
        if (!jumpPassword) return; // Blank on an edit = keep the saved one.
        if ((await saveToVault(jumpCredentialKey(config), jumpPassword)) === 'deferred') {
          notify.info('Unlock the vault to save the jump password', 'It is kept until you unlock.');
          useSessionStore.getState().setShowVaultUnlock(true);
        }
      };

      if (editing) {
        // Write the saved host back under the SAME id — save_session replaces
        // the stored entry by id — so its sidebar spot, tags, key file, AI
        // agent and any open tab stay attached. A custom name is kept; a name
        // that was just the old address follows the new one. (Before the
        // last-used updates below: editing a host isn't choosing new defaults.)
        const before = editing.config;
        const autoNamed = before.name === (before.host || before.serialPort);
        const updated: ConnectionConfig = {
          ...before,
          ...config,
          id: before.id,
          name: autoNamed ? config.name : before.name,
        };
        const stored = await invoke('save_session', {
          config: saveSessionPayload(updated),
          folderId: editing.folderId,
        })
          .then(() => true)
          .catch(() => false);
        if (!stored) throw new Error('Could not save the changes. The saved host was not updated.');
        await saveJumpPassword();
        const { password, jumpPassword, privateKey, keyPassphrase, ...safe } = updated;
        void password;
        void jumpPassword;
        void privateKey;
        void keyPassphrase;
        // Updates the sidebar item and every open tab of it. A tab that is
        // still connected keeps its connection details (updateSavedHost) —
        // say so, or the old address staying on the tab looks like a bug.
        const st = useSessionStore.getState();
        st.updateSavedHost(updated.id, safe);
        const liveTab = st.sessions.some(
          (s) =>
            savedHostId(s.config) === updated.id &&
            (s.connected || s.connectionStatus === 'connecting' || s.connectionStatus === 'reconnecting')
        );
        if (liveTab) {
          notify.info('Host updated', `${updated.name}: the open tab keeps its current connection — Reconnect to use the new details.`);
        } else {
          notify.success('Host updated', updated.name);
        }
        setShowQuickConnect(false);
        return;
      }

      if (protocol !== 'local') {
        setLastUsedDeviceType(config.deviceType);
        setLastUsedDeviceProfileId(config.deviceProfileId || 'builtin-generic');
      }
      if (protocol === 'ssh' && target?.username) setLastUsedSshUsername(target.username);

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
          await saveJumpPassword();
        } else {
          notify.error('Could not save session', 'It was not added to the sidebar.');
        }
      }

      // Don't wait for the connect itself: handleConnect opens the tab (with
      // its own connecting spinner) synchronously and reports failures via
      // toast / the auth prompt. Awaiting it kept this dialog on a disabled
      // "Connecting…" button for as long as a slow or unreachable host took —
      // and since this component stays mounted, reopening Quick Connect for
      // the NEXT session showed "Connecting…" too, then wiped the new form
      // when the old connect finally finished.
      void onConnect(config);
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
    setLastUsedDeviceType(profile.deviceType);
    setLastUsedDeviceProfileId(profile.id);
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
            <h2 className="text-[16px] font-semibold text-[var(--text-primary)]">
              {editing ? `Edit ${editing.config.name}` : 'Quick Connect'}
            </h2>
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
                    onBlur={applyHostSpec}
                    placeholder="10.0.0.1 or admin@switch:22"
                    autoFocus
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
                  <div className="flex gap-1.5">
                    {serialChoices.length > 0 ? (
                      <select
                        value={typingSerial ? CUSTOM_SERIAL : serialPort}
                        onChange={(e) => {
                          const picked = e.target.value;
                          setCustomSerial(picked === CUSTOM_SERIAL);
                          if (picked !== CUSTOM_SERIAL) setSerialPort(picked);
                        }}
                        className={`${inputCls} flex-1 min-w-0`}
                      >
                        <option value="">Choose a port…</option>
                        {serialChoices.map((p) => (
                          <option key={p} value={p}>
                            {p}
                          </option>
                        ))}
                        <option value={CUSTOM_SERIAL}>Custom…</option>
                      </select>
                    ) : (
                      <input
                        type="text"
                        value={serialPort}
                        onChange={(e) => setSerialPort(e.target.value)}
                        placeholder={SERIAL_PLACEHOLDER}
                        required
                        className={`${inputCls} flex-1 min-w-0 font-mono`}
                      />
                    )}
                    <button
                      type="button"
                      onClick={() => void loadSerialPorts()}
                      disabled={scanningPorts}
                      className="flex items-center justify-center h-9 w-9 flex-shrink-0 rounded-[var(--radius)] bg-[var(--bg-tertiary)] hover:bg-[var(--border-strong)] text-[var(--text-secondary)] hover:text-[var(--text-primary)] transition-colors disabled:opacity-50"
                      title="Look for serial ports again (after plugging in a cable)"
                    >
                      <RefreshCw size={14} className={scanningPorts ? 'animate-spin' : ''} />
                    </button>
                  </div>
                  {serialChoices.length > 0 && typingSerial && (
                    <input
                      type="text"
                      value={serialPort}
                      onChange={(e) => {
                        setCustomSerial(true);
                        setSerialPort(e.target.value);
                      }}
                      placeholder={SERIAL_PLACEHOLDER}
                      autoFocus={customSerial}
                      required
                      className={`${inputCls} mt-1.5 font-mono`}
                    />
                  )}
                  {serialPorts?.length === 0 && !scanningPorts && (
                    <p className="text-[10px] text-[var(--text-muted)] mt-1">
                      No serial ports found. Plug in the console cable and press refresh, or type the port name.
                    </p>
                  )}
                </div>
                <div>
                  <label className="block text-[11px] font-semibold uppercase tracking-wide text-[var(--text-secondary)] mb-1.5">
                    Baud
                  </label>
                  <select
                    value={baudRate}
                    onChange={(e) => {
                      setBaudRate(Number(e.target.value));
                      setBaudTouched(true);
                    }}
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
                {/* Optional when a shared login supplies one. */}
                {protocol === 'ssh' && !login && <span className="text-[var(--accent-danger)]"> *</span>}
              </label>
              <input
                type="text"
                value={username}
                onChange={(e) => setUsername(e.target.value)}
                // No sample name: a grey "admin" looked filled in, and SSH then
                // logged in with an empty username.
                placeholder={
                  protocol === 'ssh'
                    ? login
                      ? `${login.username} (from the ${login.name} login)`
                      : 'Required'
                    : 'Optional (the device asks when you connect)'
                }
                autoComplete="username"
                className={inputCls}
              />
              {/* A username here overrides the shared login's — easy to miss
                  when it was prefilled from the last connect. */}
              {protocol === 'ssh' && login && username.trim() && username.trim() !== login.username && (
                <p className="text-[10px] text-[var(--text-muted)] mt-1">
                  Logs in as {username.trim()}, not the {login.name} login&apos;s {login.username}.{' '}
                  <button
                    type="button"
                    onClick={() => setUsername('')}
                    className="text-[var(--accent)] hover:underline"
                  >
                    Use {login.username}
                  </button>
                </p>
              )}
            </div>
          )}

          {/* Shared login (Settings → Logins): change its password once for
              every host that uses it. */}
          {protocol === 'ssh' && passwordAuth && loginProfiles.length > 0 && (
            <div>
              <label className="block text-[11px] font-semibold uppercase tracking-wide text-[var(--text-secondary)] mb-1.5">
                Login
              </label>
              <select value={loginChoice} onChange={(e) => setLoginChoice(e.target.value)} className={inputCls}>
                <option value="">
                  {targetFolder
                    ? `Folder default (${folderLogin ? folderLogin.name : 'none set'})`
                    : 'No shared login'}
                </option>
                {loginProfiles.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name} — {p.username}
                  </option>
                ))}
                <option value={PER_HOST_PASSWORD}>Per-host password</option>
              </select>
              <p className="text-[10px] text-[var(--text-muted)] mt-1">
                {login
                  ? `Uses the password saved for the ${login.name} login.`
                  : 'Uses a password saved for this host, or asks when you connect.'}
              </p>
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
                      placeholder={
                        loginProfiles.find((p) => p.id === jumpLogin)?.username ?? 'Jump username'
                      }
                      className="input-field h-8 px-2 text-xs"
                    />
                    <select
                      value={jumpLogin}
                      onChange={(e) => setJumpLogin(e.target.value)}
                      className="input-field h-8 px-2 text-xs"
                      title="How to log in to the jump host"
                    >
                      <option value={PER_HOST_PASSWORD}>Password</option>
                      <option value="">Key / SSH agent</option>
                      {loginProfiles.map((p) => (
                        <option key={p.id} value={p.id}>
                          Login: {p.name}
                        </option>
                      ))}
                    </select>
                  </div>
                  {jumpLogin === PER_HOST_PASSWORD && (
                    <input
                      type="password"
                      value={jumpPassword}
                      onChange={(e) => setJumpPassword(e.target.value)}
                      placeholder={
                        editing ? 'Jump password (leave blank to keep the saved one)' : 'Jump password'
                      }
                      className="input-field w-full h-8 px-2 text-xs"
                    />
                  )}
                  <p className="text-[10px] text-[var(--text-muted)]">
                    Connect to the target through this bastion (ProxyJump).{' '}
                    {jumpLogin === PER_HOST_PASSWORD
                      ? 'Saved hosts keep the password in the encrypted vault.'
                      : jumpLogin
                        ? 'Uses the shared login\u2019s saved password.'
                        : 'Logs in with your key or SSH agent.'}{' '}
                    Bastions that ask for a one-time code (MFA) aren&apos;t supported yet.
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

          {/* Save (an edit always saves) */}
          {!editing && (
            <label className="flex items-center gap-2 cursor-pointer select-none">
              <input
                type="checkbox"
                checked={saveSession}
                onChange={(e) => setSaveSession(e.target.checked)}
                className="w-4 h-4 rounded"
              />
              <span className="text-sm text-[var(--text-secondary)]">Save to Sidebar</span>
            </label>
          )}

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
              disabled={
                connecting ||
                (isHostBased && !host.trim()) ||
                (protocol === 'serial' && !serialPort.trim()) ||
                missingSshUser
              }
              title={missingSshUser ? 'Enter the username to log in as' : undefined}
              className="btn-accent flex-1 flex items-center justify-center gap-2 h-10 text-sm disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {editing ? <Save size={15} /> : <Plug size={15} />}
              {editing ? (connecting ? 'Saving…' : 'Save') : connecting ? 'Connecting…' : 'Connect'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
