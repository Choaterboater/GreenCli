import { createContext, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import {
  RotateCcw,
  Moon,
  Sun,
  Monitor,
  Eye,
  EyeOff,
  CheckCircle2,
  Download,
  Upload,
  Settings as SettingsIcon,
  Palette,
  TerminalSquare,
  ShieldCheck,
  Workflow,
  Sparkles,
  Cloud,
  ArchiveRestore,
  type LucideIcon,
} from 'lucide-react';
import { invoke } from '@tauri-apps/api/core';
import { open as openDialog, save as saveDialog } from '@tauri-apps/plugin-dialog';
import { useSessionStore } from '../store/sessionStore';
import { useSettingsStore } from '../store/settingsStore';
import { askConfirm, useDialogStore } from '../store/dialogStore';
import { AI_PROVIDERS, AI_CLI_PRESETS, isCliProvider, TerminalSettings, TerminalColorScheme, TERMINAL_SCHEMES, DeviceType, DEVICE_TYPES, DeviceProfile, SessionFolder, ThemePreference } from '../types';
import { useSystemTheme } from '../hooks/useTheme';
import { notify } from '../store/toastStore';
import McpServers from './McpServers';
import AiAgents from './AiAgents';
import CasperSettings from './CasperSettings';
import HostsManager from './HostsManager';
import LoginProfiles from './LoginProfiles';
import TriggersSettings from './TriggersSettings';
import CentralSettings from './CentralSettings';
import { generateId } from '../utils';
import { BackupImportMode, createGreenCliBackup, GreenCliBackup, importGreenCliBackup } from '../utils/backup';
import { sanitizeStandaloneImportedProfiles } from '../utils/deviceProfiles';
import { isMac } from '../utils/shortcuts';
import {
  SETTINGS_GROUPS,
  SETTINGS_SECTIONS,
  groupForFocus,
  searchSettings,
  type SettingsGroupId,
} from '../utils/settingsSections';
import LargeModal, { ModalRail, RailItem } from './LargeModal';
import { plainHttpWarning } from '../utils/urlSafety';
import { isTauri } from '../utils/tauri';

// Curated best-practices the AI should apply, distilled from Juniper Validated
// Designs (JVDs). Appended to the references field on request.
const JVD_REFERENCES = `# Juniper Validated Design (JVD) best-practices
- EVPN-VXLAN data center: eBGP IP-fabric underlay (lo0 reachability), eBGP EVPN
  overlay with family evpn signaling; prefer ERB (edge-routed bridging) with IRB
  anycast gateways; consistent route-targets/VNIs; MTU/jumbo on fabric links.
- AI/GPU (RoCEv2) fabric: lossless Ethernet — PFC on the RoCE priority + ECN
  marking (WRED), rail-optimized topology, no oversubscription on GPU-facing links;
  verify no tail drops / PFC pause storms.
- EVPN campus: collapsed/distributed EVPN, map VLANs to VNIs, ESI-LAG for
  multihoming, Mist Wired Assurance for SLE/health.
- WAN/SD-WAN: Mist WAN Assurance + application-aware routing; redundant edges.
- Verification (operational intent): underlay/overlay BGP all Established, EVPN
  routes present (bgp.evpn.0), VXLAN VTEPs up, no interface errors/drops.
- General: out-of-band mgmt, RFC5549 or lo0 /32s, config via automation where managed,
  golden config + commit confirmed.`;

const THEME_OPTIONS: { id: ThemePreference; label: string; Icon: typeof Sun }[] = [
  { id: 'system', label: 'System', Icon: Monitor },
  { id: 'dark', label: 'Dark', Icon: Moon },
  { id: 'light', label: 'Light', Icon: Sun },
];

function SystemThemeNote() {
  const system = useSystemTheme();
  return (
    <p className="mt-1.5 text-[11px] text-[var(--text-muted)]">
      Follows your computer&apos;s light/dark setting — {system} right now.
    </p>
  );
}

const GROUP_ICONS: Record<SettingsGroupId, LucideIcon> = {
  appearance: Palette,
  terminal: TerminalSquare,
  connections: ShieldCheck,
  automation: Workflow,
  ai: Sparkles,
  integrations: Cloud,
  backup: ArchiveRestore,
};

// Which sections are showing — the active group's, or every search hit — so
// each <Section> can hide itself and draw the divider above itself only when
// something visible comes before it.
const SectionVisibility = createContext<{ visible: string[]; searching: boolean }>({
  visible: [],
  searching: false,
});

function Section({ id, children }: { id: string; children: ReactNode }) {
  const { visible, searching } = useContext(SectionVisibility);
  const idx = visible.indexOf(id);
  const meta = SETTINGS_SECTIONS.find((m) => m.id === id);
  const prev = idx > 0 ? SETTINGS_SECTIONS.find((m) => m.id === visible[idx - 1]) : undefined;
  // While searching, hits from several groups are listed together: label the
  // first hit of each group so you know where it lives.
  const groupLabel =
    searching && idx >= 0 && meta && prev?.group !== meta.group
      ? SETTINGS_GROUPS.find((g) => g.id === meta.group)?.label
      : undefined;
  return (
    <div hidden={idx < 0} className={idx > 0 ? 'mt-5 pt-5 border-t border-[var(--border)]' : undefined}>
      {groupLabel && (
        <p className="mb-2.5 text-[10px] font-semibold uppercase tracking-wider text-[var(--text-muted)]">
          {groupLabel}
        </p>
      )}
      {children}
    </div>
  );
}

function Toggle({ on, onChange, label }: { on: boolean; onChange: (v: boolean) => void; label: string }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={on}
      aria-label={label}
      onClick={() => onChange(!on)}
      className="w-9 h-5 rounded-full transition-colors cursor-pointer relative flex-shrink-0"
      style={{ background: on ? 'var(--accent)' : 'var(--border-strong)' }}
    >
      <span
        className="absolute top-0.5 left-0.5 w-4 h-4 rounded-full bg-white shadow-sm transition-transform"
        style={{ transform: on ? 'translateX(16px)' : 'translateX(0)' }}
      />
    </button>
  );
}

/** Session logging: auto-log, log folder, per-line timestamps. */
function SessionLogSettings() {
  const autoLogSessions = useSettingsStore((s) => s.autoLogSessions);
  const sessionLogDir = useSettingsStore((s) => s.sessionLogDir);
  const sessionLogTimestamps = useSettingsStore((s) => s.sessionLogTimestamps);
  const updateSettings = useSettingsStore((s) => s.updateSettings);

  const chooseFolder = async () => {
    try {
      const picked = await openDialog({
        title: 'Choose the session log folder',
        directory: true,
        multiple: false,
        defaultPath: sessionLogDir || undefined,
      });
      if (typeof picked === 'string') updateSettings({ sessionLogDir: picked });
    } catch (e) {
      notify.warning('Could not choose a folder', String(e));
    }
  };

  const openFolder = () => {
    invoke('reveal_log_folder', { dir: sessionLogDir || null }).catch((e) =>
      notify.warning('Could not open the log folder', String(e))
    );
  };

  const rows = [
    {
      label: 'Log every session automatically',
      hint: 'Starts a log as soon as a session connects. Stop one any time with REC in the status bar.',
      value: autoLogSessions,
      onChange: (v: boolean) => updateSettings({ autoLogSessions: v }),
    },
    {
      label: 'Timestamp each line',
      hint: 'Adds the time, like [14:02:11], to the start of every line. Applies to logs started after you change it.',
      value: sessionLogTimestamps,
      onChange: (v: boolean) => updateSettings({ sessionLogTimestamps: v }),
    },
  ];

  return (
    <section id="set-logging">
      <h3 className="text-sm font-semibold text-[var(--text-primary)] mb-1.5">Session Logging</h3>
      <p className="text-xs text-[var(--text-muted)] mb-3">
        Logs are plain text with colors and screen codes removed, named like
        {' '}<span className="font-mono">core-sw1_2026-09-27_140211.log</span>. Logs can
        contain passwords you type or paste, so keep the folder private.
      </p>
      <div className="space-y-2 mb-3">
        {rows.map(({ label, hint, value, onChange }) => (
          <div key={label} className="flex items-center justify-between gap-3 py-1">
            <div className="min-w-0">
              <div className="text-sm text-[var(--text-primary)]">{label}</div>
              <div className="text-[11px] text-[var(--text-muted)]">{hint}</div>
            </div>
            <Toggle on={value} onChange={onChange} label={label} />
          </div>
        ))}
      </div>
      <label className="block text-xs text-[var(--text-secondary)] mb-1.5">Log folder</label>
      <div className="flex items-center gap-2">
        <div
          className="flex-1 min-w-0 h-8 px-2.5 flex items-center rounded border border-[var(--border)] bg-[var(--bg-primary)] text-xs font-mono truncate"
          title={sessionLogDir || 'Default: the app data folder'}
        >
          {sessionLogDir ? (
            <span className="truncate text-[var(--text-primary)]">{sessionLogDir}</span>
          ) : (
            <span className="text-[var(--text-muted)]">Default (app data folder)</span>
          )}
        </div>
        {isTauri && (
          <button
            onClick={chooseFolder}
            className="px-3 h-8 rounded bg-[var(--bg-tertiary)] hover:bg-[var(--border-strong)] text-xs text-[var(--text-primary)] flex-shrink-0"
          >
            Choose…
          </button>
        )}
        {sessionLogDir && (
          <button
            onClick={() => updateSettings({ sessionLogDir: '' })}
            className="px-2 h-8 rounded text-xs text-[var(--text-secondary)] hover:bg-[var(--bg-tertiary)] flex-shrink-0"
            title="Go back to the default folder"
          >
            Use default
          </button>
        )}
        {isTauri && (
          <button
            onClick={openFolder}
            className="px-2 h-8 rounded text-xs text-[var(--text-secondary)] hover:bg-[var(--bg-tertiary)] flex-shrink-0"
            title="Open the log folder in Finder / Explorer"
          >
            Open folder
          </button>
        )}
      </div>
      <p className="text-[11px] text-[var(--text-muted)] mt-1">
        A new folder applies to logs started after you change it.
      </p>
    </section>
  );
}

export default function SettingsPanel() {
  // Narrow per-field selectors — whole-store subscriptions re-rendered the
  // whole settings modal on every unrelated session/settings change.
  const showSettings = useSessionStore((s) => s.showSettings);
  const setShowSettings = useSessionStore((s) => s.setShowSettings);
  const settingsFocus = useSessionStore((s) => s.settingsFocus);
  const setSettingsFocus = useSessionStore((s) => s.setSettingsFocus);
  const setFolders = useSessionStore((s) => s.setFolders);
  const settings = {
    addDeviceProfile: useSettingsStore((s) => s.addDeviceProfile),
    aiModel: useSettingsStore((s) => s.aiModel),
    aiProvider: useSettingsStore((s) => s.aiProvider),
    aiReferences: useSettingsStore((s) => s.aiReferences),
    aiUseCxRest: useSettingsStore((s) => s.aiUseCxRest),
    aiUseMcp: useSettingsStore((s) => s.aiUseMcp),
    aiUseTerminal: useSettingsStore((s) => s.aiUseTerminal),
    autoReconnect: useSettingsStore((s) => s.autoReconnect),
    bell: useSettingsStore((s) => s.bell),
    captureOnConnect: useSettingsStore((s) => s.captureOnConnect),
    colorScheme: useSettingsStore((s) => s.colorScheme),
    confirmCloseConnected: useSettingsStore((s) => s.confirmCloseConnected),
    copyOnSelect: useSettingsStore((s) => s.copyOnSelect),
    cursorBlink: useSettingsStore((s) => s.cursorBlink),
    cursorStyle: useSettingsStore((s) => s.cursorStyle),
    customDeviceProfiles: useSettingsStore((s) => s.customDeviceProfiles),
    fontFamily: useSettingsStore((s) => s.fontFamily),
    fontSize: useSettingsStore((s) => s.fontSize),
    intentScheduleMinutes: useSettingsStore((s) => s.intentScheduleMinutes),
    intentScheduling: useSettingsStore((s) => s.intentScheduling),
    intentWebhookUrl: useSettingsStore((s) => s.intentWebhookUrl),
    keepAliveInterval: useSettingsStore((s) => s.keepAliveInterval),
    localCliCommand: useSettingsStore((s) => s.localCliCommand),
    macOptionIsMeta: useSettingsStore((s) => s.macOptionIsMeta),
    middleClickPaste: useSettingsStore((s) => s.middleClickPaste),
    mistBaseUrl: useSettingsStore((s) => s.mistBaseUrl),
    mistToken: useSettingsStore((s) => s.mistToken),
    moonshotModel: useSettingsStore((s) => s.moonshotModel),
    ollamaModel: useSettingsStore((s) => s.ollamaModel),
    ollamaUrl: useSettingsStore((s) => s.ollamaUrl),
    openrouterModel: useSettingsStore((s) => s.openrouterModel),
    pasteGuardEnabled: useSettingsStore((s) => s.pasteGuardEnabled),
    pasteGuardLineThreshold: useSettingsStore((s) => s.pasteGuardLineThreshold),
    pasteHistoryEnabled: useSettingsStore((s) => s.pasteHistoryEnabled),
    removeDeviceProfile: useSettingsStore((s) => s.removeDeviceProfile),
    resetToDefaults: useSettingsStore((s) => s.resetToDefaults),
    rightClickBehavior: useSettingsStore((s) => s.rightClickBehavior),
    scrollback: useSettingsStore((s) => s.scrollback),
    setAiModel: useSettingsStore((s) => s.setAiModel),
    setAiProvider: useSettingsStore((s) => s.setAiProvider),
    setAiReferences: useSettingsStore((s) => s.setAiReferences),
    setAutoReconnect: useSettingsStore((s) => s.setAutoReconnect),
    setBell: useSettingsStore((s) => s.setBell),
    setCaptureOnConnect: useSettingsStore((s) => s.setCaptureOnConnect),
    setColorScheme: useSettingsStore((s) => s.setColorScheme),
    setCursorBlink: useSettingsStore((s) => s.setCursorBlink),
    setCursorStyle: useSettingsStore((s) => s.setCursorStyle),
    setFontFamily: useSettingsStore((s) => s.setFontFamily),
    setFontSize: useSettingsStore((s) => s.setFontSize),
    setIntentScheduleMinutes: useSettingsStore((s) => s.setIntentScheduleMinutes),
    setIntentScheduling: useSettingsStore((s) => s.setIntentScheduling),
    setIntentWebhookUrl: useSettingsStore((s) => s.setIntentWebhookUrl),
    setKeepAliveInterval: useSettingsStore((s) => s.setKeepAliveInterval),
    setLocalCliCommand: useSettingsStore((s) => s.setLocalCliCommand),
    setMiddleClickPaste: useSettingsStore((s) => s.setMiddleClickPaste),
    setMoonshotModel: useSettingsStore((s) => s.setMoonshotModel),
    setOllamaModel: useSettingsStore((s) => s.setOllamaModel),
    setOllamaUrl: useSettingsStore((s) => s.setOllamaUrl),
    setOpenrouterModel: useSettingsStore((s) => s.setOpenrouterModel),
    setScrollback: useSettingsStore((s) => s.setScrollback),
    setSyntaxHighlighting: useSettingsStore((s) => s.setSyntaxHighlighting),
    setTheme: useSettingsStore((s) => s.setTheme),
    smartTerminalLinks: useSettingsStore((s) => s.smartTerminalLinks),
    syntaxHighlighting: useSettingsStore((s) => s.syntaxHighlighting),
    terminalActivityNotifications: useSettingsStore((s) => s.terminalActivityNotifications),
    terminalSilenceNotifications: useSettingsStore((s) => s.terminalSilenceNotifications),
    terminalSilenceThresholdSeconds: useSettingsStore((s) => s.terminalSilenceThresholdSeconds),
    theme: useSettingsStore((s) => s.theme),
    updateSettings: useSettingsStore((s) => s.updateSettings),
    verifyDeviceTls: useSettingsStore((s) => s.verifyDeviceTls),
  };

  const [activeNav, setActiveNav] = useState<SettingsGroupId>('appearance');
  const [query, setQuery] = useState('');
  const matches = useMemo(() => searchSettings(query), [query]);
  const searchRef = useRef<HTMLInputElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);

  // Each opening starts with an empty search, and the cursor in it — unless
  // a deep link is about to jump to a section.
  useEffect(() => {
    if (!showSettings) return;
    setQuery('');
    if (useSessionStore.getState().settingsFocus) return;
    const id = setTimeout(() => searchRef.current?.focus(), 50);
    return () => clearTimeout(id);
  }, [showSettings]);

  // A new group or search starts at the top.
  useEffect(() => {
    contentRef.current?.scrollTo({ top: 0 });
  }, [activeNav, query]);

  // When opened via a Help deep-link (or the palette's MCP Servers), switch to
  // the nav group that owns the section, then scroll + flash it.
  useEffect(() => {
    if (!showSettings || !settingsFocus) return;
    setQuery('');
    const group = groupForFocus(settingsFocus);
    if (group) setActiveNav(group);
    const id = setTimeout(() => {
      const el = document.getElementById(`set-${settingsFocus}`);
      if (el) {
        el.scrollIntoView({ behavior: 'smooth', block: 'center' });
        el.classList.add('help-flash');
        setTimeout(() => el.classList.remove('help-flash'), 1600);
      }
      setSettingsFocus(null);
    }, 120);
    return () => clearTimeout(id);
  }, [showSettings, settingsFocus, setSettingsFocus]);

  // Close on Escape — unless a nested confirm dialog (e.g. settings reset) is
  // open; the dialog owns Escape in that case.
  useEffect(() => {
    if (!showSettings) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      if (useDialogStore.getState().current) return;
      setShowSettings(false);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [showSettings, setShowSettings]);
  const [showApiKey, setShowApiKey] = useState(false);
  const [keyInput, setKeyInput] = useState('');
  const [keySaved, setKeySaved] = useState(false);
  const [profileName, setProfileName] = useState('');
  const [profileBase, setProfileBase] = useState<DeviceType>('generic');
  const [backupBusy, setBackupBusy] = useState<'export' | 'import' | null>(null);
  const [backupMode, setBackupMode] = useState<BackupImportMode>('merge');

  const aiProvider = settings.aiProvider;
  const providerMeta = AI_PROVIDERS.find((p) => p.value === aiProvider);

  // When the selected provider changes, reflect whether a key is already stored
  // (in the Rust key store) and reset the transient input.
  useEffect(() => {
    setKeyInput('');
    if (providerMeta?.needsKey) {
      invoke<boolean>('ai_has_key', { provider: aiProvider })
        .then(setKeySaved)
        .catch(() => setKeySaved(false));
    } else {
      setKeySaved(false);
    }
  }, [aiProvider, providerMeta?.needsKey]);

  const saveKey = () => {
    // Don't overwrite a stored key when the (always-empty-on-open) field is
    // blurred without typing — that would silently wipe a saved key.
    if (!keyInput) return;
    invoke('ai_set_key', { provider: aiProvider, key: keyInput })
      .then(() => setKeySaved(true))
      .catch(() => {});
  };

  // The key otherwise saves only on the input's onBlur. Every close path (Escape,
  // backdrop mousedown, X button) just sets showSettings=false, which hides the
  // panel via `return null` below WITHOUT unmounting — App renders <SettingsPanel/>
  // unconditionally — so React fires neither a blur nor an unmount cleanup. Flush
  // any pending key on the open→closed transition instead.
  const keyFlushRef = useRef({ keyInput, aiProvider });
  keyFlushRef.current = { keyInput, aiProvider };
  const wasOpenRef = useRef(showSettings);
  useEffect(() => {
    if (wasOpenRef.current && !showSettings) {
      const { keyInput: pending, aiProvider: provider } = keyFlushRef.current;
      if (pending) invoke('ai_set_key', { provider, key: pending }).catch(() => {});
      // The panel stays mounted across close (App renders it unconditionally),
      // so the typed key would otherwise still be sitting in the input — and
      // behind the reveal toggle — on reopen. Clear it on every close.
      setKeyInput('');
    }
    wasOpenRef.current = showSettings;
  }, [showSettings]);

  const addProfile = () => {
    const name = profileName.trim();
    if (!name) return;
    const base = DEVICE_TYPES.find((d) => d.value === profileBase) ?? DEVICE_TYPES[0];
    settings.addDeviceProfile({
      id: `custom-${generateId()}`,
      name,
      deviceType: profileBase,
      short: name.slice(0, 6).toUpperCase(),
      color: `var(--vendor-${base.vendor})`,
      description: `Custom profile based on ${base.label}.`,
      promptPatterns: [],
      fingerprints: [],
      commands: [],
      keywords: [],
    });
    setProfileName('');
  };

  const exportProfiles = async () => {
    const contents = JSON.stringify(settings.customDeviceProfiles, null, 2);
    // Blob-anchor downloads are a silent no-op in the Tauri webview (no
    // download handler) — go through the native save dialog like exportBackup.
    if (isTauri) {
      const path = await saveDialog({
        title: 'Export device profiles',
        defaultPath: 'greencli-device-profiles.json',
        filters: [{ name: 'JSON', extensions: ['json'] }],
      }).catch(() => null);
      if (!path) return;
      await invoke('write_file_text', { path, contents }).catch(() => {});
      return;
    }
    const blob = new Blob([contents], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'greencli-device-profiles.json';
    a.click();
    URL.revokeObjectURL(url);
  };

  const importProfiles = () => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = 'application/json';
    input.onchange = () => {
      const file = input.files?.[0];
      if (!file) return;
      const reader = new FileReader();
      reader.onload = () => {
        try {
          const parsed = sanitizeStandaloneImportedProfiles(JSON.parse(String(reader.result || '[]')));
          parsed.forEach((profile) => settings.addDeviceProfile(profile));
        } catch {
          // Ignore malformed imports; the mapper also surfaces import errors.
        }
      };
      reader.readAsText(file);
    };
    input.click();
  };

  const exportBackup = async () => {
    setBackupBusy('export');
    try {
      const backup = await createGreenCliBackup();
      const contents = JSON.stringify(backup, null, 2);
      const fileName = `greencli-backup-${new Date().toISOString().slice(0, 10)}.json`;
      if (isTauri) {
        const path = await saveDialog({
          title: 'Export GreenCLI backup',
          defaultPath: fileName,
          filters: [{ name: 'JSON', extensions: ['json'] }],
        });
        if (!path) return;
        await invoke('write_file_text', { path, contents });
      } else {
        const blob = new Blob([contents], { type: 'application/json' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = fileName;
        a.click();
        URL.revokeObjectURL(url);
      }
      notify.success('Backup exported', 'Secrets and vault contents were not included.');
    } catch (e) {
      notify.error('Backup export failed', String(e));
    } finally {
      setBackupBusy(null);
    }
  };

  const pickBackupText = async (): Promise<string | null> => {
    if (isTauri) {
      const picked = await openDialog({
        title: 'Import GreenCLI backup',
        multiple: false,
        filters: [{ name: 'JSON', extensions: ['json'] }],
      });
      if (typeof picked !== 'string') return null;
      return invoke<string>('read_file_text', { path: picked });
    }

    const input = document.createElement('input');
    input.type = 'file';
    input.accept = 'application/json';
    return new Promise((resolve) => {
      input.onchange = () => {
        const file = input.files?.[0];
        if (!file) return resolve(null);
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result || ''));
        reader.onerror = () => resolve(null);
        reader.readAsText(file);
      };
      input.click();
    });
  };

  const importBackup = async () => {
    setBackupBusy('import');
    try {
      const text = await pickBackupText();
      if (!text) return;
      const backup = JSON.parse(text) as GreenCliBackup;
      if (backupMode === 'replace') {
        const ok = await askConfirm({
          title: 'Replace existing GreenCLI data?',
          message:
            'This replaces snippets, triggers, saved sessions, and intents with the backup contents. Secrets and vault data are not imported.',
          confirmLabel: 'Replace',
          danger: true,
        });
        if (!ok) return;
      }
      const result = await importGreenCliBackup(backup, backupMode);
      const folders = await invoke<SessionFolder[]>('list_folders').catch(() => []);
      if (folders.length) setFolders(folders);
      notify.success(
        'Backup imported',
        `${backupMode === 'replace' ? 'Replaced' : 'Merged'} ${result.sessions} sessions, ${result.intents} intents, ${result.snippets} snippets, and ${result.triggers} triggers.`
      );
      if (result.warnings.length) {
        notify.warning(
          `${result.warnings.length} item${result.warnings.length === 1 ? '' : 's'} failed to import`,
          result.warnings.slice(0, 5).join('\n') + (result.warnings.length > 5 ? `\n…and ${result.warnings.length - 5} more` : '')
        );
      }
    } catch (e) {
      notify.error('Backup import failed', String(e));
    } finally {
      setBackupBusy(null);
    }
  };

  if (!showSettings) return null;

  const searching = query.trim() !== '';
  const visible = searching
    ? matches.map((m) => m.id)
    : SETTINGS_SECTIONS.filter((m) => m.group === activeNav).map((m) => m.id);

  return (
    <LargeModal title="Settings" icon={SettingsIcon} onClose={() => setShowSettings(false)}>
      <ModalRail
        query={query}
        onQueryChange={setQuery}
        placeholder="Search settings…"
        inputRef={searchRef}
        listLabel="Settings sections"
      >
        {SETTINGS_GROUPS.map((g) => {
          const hits = matches.filter((m) => m.group === g.id).length;
          return (
            <RailItem
              key={g.id}
              icon={GROUP_ICONS[g.id]}
              label={g.label}
              active={!searching && activeNav === g.id}
              count={searching && hits > 0 ? hits : undefined}
              dimmed={searching && hits === 0}
              onClick={() => {
                // Picking a group leaves search: show that group's sections.
                setQuery('');
                setActiveNav(g.id);
              }}
            />
          );
        })}
      </ModalRail>

      <div ref={contentRef} className="flex-1 overflow-y-auto px-6 py-5">
        {searching && (
          <p className="mb-4 text-[12px] text-[var(--text-muted)]" aria-live="polite">
            {matches.length === 0
              ? `No settings match “${query.trim()}”.`
              : `${matches.length} ${matches.length === 1 ? 'section matches' : 'sections match'} “${query.trim()}”.`}
          </p>
        )}
        <SectionVisibility.Provider value={{ visible, searching }}>
          <Section id="appearance">
            <section id="set-appearance">
              <h3 className="text-sm font-semibold text-[var(--text-primary)] mb-3">
                Appearance
              </h3>

              {/* Theme */}
              <div className="mb-3">
                <label className="block text-xs text-[var(--text-secondary)] mb-1.5">
                  Theme
                </label>
                <div className="flex gap-2" role="group" aria-label="Theme">
                  {THEME_OPTIONS.map(({ id, label, Icon }) => (
                    <button
                      key={id}
                      aria-pressed={settings.theme === id}
                      onClick={() => settings.setTheme(id)}
                      className={`
                        flex items-center justify-center gap-2 flex-1 py-2 rounded-lg border text-sm transition-colors
                        ${
                          settings.theme === id
                            ? 'bg-[var(--bg-tertiary)] border-[var(--accent)] text-[var(--text-primary)]'
                            : 'bg-[var(--bg-primary)] border-[var(--border)] text-[var(--text-secondary)] hover:border-[var(--text-muted)]'
                        }
                      `}
                    >
                      <Icon size={14} />
                      {label}
                    </button>
                  ))}
                </div>
                {settings.theme === 'system' && <SystemThemeNote />}
              </div>

              {/* Terminal color scheme */}
              <div className="mb-3">
                <label className="block text-xs text-[var(--text-secondary)] mb-1.5">
                  Terminal Color Scheme
                </label>
                <select
                  value={settings.colorScheme}
                  onChange={(e) => settings.setColorScheme(e.target.value as TerminalColorScheme)}
                  className="w-full px-3 py-2 bg-[var(--bg-primary)] border border-[var(--border)] rounded-lg text-sm text-[var(--text-primary)] focus:outline-none focus:border-[var(--accent)]"
                >
                  {TERMINAL_SCHEMES.map((s) => (
                    <option key={s.id} value={s.id}>
                      {s.label}
                    </option>
                  ))}
                </select>
              </div>

              {/* Font */}
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-xs text-[var(--text-secondary)] mb-1.5">
                    Font Size
                  </label>
                  <div className="flex items-center gap-2">
                    <input
                      type="range"
                      min={8}
                      max={24}
                      value={settings.fontSize}
                      onChange={(e) =>
                        settings.setFontSize(Number(e.target.value))
                      }
                      className="flex-1 accent-[var(--accent)]"
                    />
                    <span className="text-sm text-[var(--text-primary)] w-6 text-right">
                      {settings.fontSize}
                    </span>
                  </div>
                </div>
                <div>
                  <label className="block text-xs text-[var(--text-secondary)] mb-1.5">
                    Font Family
                  </label>
                  <select
                    value={settings.fontFamily}
                    onChange={(e) => settings.setFontFamily(e.target.value)}
                    className="w-full h-8 px-2 bg-[var(--bg-primary)] border border-[var(--border)] rounded-lg text-sm text-[var(--text-primary)] focus:outline-none focus:border-[var(--accent)]"
                  >
                    <option value="JetBrains Mono, Consolas, monospace">
                      JetBrains Mono
                    </option>
                    <option value="Consolas, monospace">Consolas</option>
                    <option value="Fira Code, monospace">Fira Code</option>
                    <option value="Source Code Pro, monospace">
                      Source Code Pro
                    </option>
                    <option value="Courier New, monospace">Courier New</option>
                  </select>
                </div>
              </div>
            </section>
          </Section>
          <Section id="terminal">
            <section id="set-terminal">
              <h3 className="text-sm font-semibold text-[var(--text-primary)] mb-3">
                Terminal
              </h3>

              <div className="grid grid-cols-2 gap-3 mb-3">
                {/* Cursor Style */}
                <div>
                  <label className="block text-xs text-[var(--text-secondary)] mb-1.5">
                    Cursor Style
                  </label>
                  <div className="flex gap-1">
                    {(['block', 'underline', 'bar'] as const).map((style) => (
                      <button
                        key={style}
                        onClick={() => settings.setCursorStyle(style)}
                        className={`
                          flex-1 py-1.5 text-xs rounded-md border capitalize transition-colors
                          ${
                            settings.cursorStyle === style
                              ? 'bg-[var(--bg-tertiary)] border-[var(--accent)] text-[var(--text-primary)]'
                              : 'bg-[var(--bg-primary)] border-[var(--border)] text-[var(--text-secondary)] hover:border-[var(--text-muted)]'
                          }
                        `}
                      >
                        {style}
                      </button>
                    ))}
                  </div>
                </div>

                {/* Scrollback */}
                <div>
                  <label className="block text-xs text-[var(--text-secondary)] mb-1.5">
                    Scrollback Lines
                  </label>
                  <div className="flex items-center gap-2">
                    <input
                      type="range"
                      min={1000}
                      max={50000}
                      step={1000}
                      value={settings.scrollback}
                      onChange={(e) =>
                        settings.setScrollback(Number(e.target.value))
                      }
                      className="flex-1 accent-[var(--accent)]"
                    />
                    <span className="text-xs text-[var(--text-primary)] w-12 text-right">
                      {settings.scrollback >= 1000
                        ? `${settings.scrollback / 1000}K`
                        : settings.scrollback}
                    </span>
                  </div>
                </div>
              </div>

              {/* Toggles */}
              <div className="space-y-2">
                {[
                  {
                    label: 'Cursor Blink',
                    value: settings.cursorBlink,
                    onChange: settings.setCursorBlink,
                  },
                  {
                    label: 'Bell',
                    value: settings.bell,
                    onChange: settings.setBell,
                  },
                  {
                    label: 'Syntax Highlighting',
                    value: settings.syntaxHighlighting,
                    onChange: settings.setSyntaxHighlighting,
                  },
                  {
                    label: 'Paste Guard',
                    value: settings.pasteGuardEnabled,
                    onChange: (value: boolean) => settings.updateSettings({ pasteGuardEnabled: value }),
                  },
                  {
                    label: 'Paste History',
                    value: settings.pasteHistoryEnabled,
                    onChange: (value: boolean) => settings.updateSettings({ pasteHistoryEnabled: value }),
                  },
                  {
                    label: 'Copy on Select',
                    value: settings.copyOnSelect,
                    onChange: (value: boolean) => settings.updateSettings({ copyOnSelect: value }),
                  },
                  {
                    label: `Smart Links (${navigator.platform.toUpperCase().includes('MAC') ? 'Cmd' : 'Ctrl'}+Click to Copy)`,
                    value: settings.smartTerminalLinks,
                    onChange: (value: boolean) => settings.updateSettings({ smartTerminalLinks: value }),
                  },
                  {
                    label: 'Background Activity Alerts',
                    value: settings.terminalActivityNotifications,
                    onChange: (value: boolean) => settings.updateSettings({ terminalActivityNotifications: value }),
                  },
                  {
                    label: 'Silence Alerts After Input',
                    value: settings.terminalSilenceNotifications,
                    onChange: (value: boolean) => settings.updateSettings({ terminalSilenceNotifications: value }),
                  },
                  {
                    label: 'Confirm Before Closing a Connected Tab',
                    value: settings.confirmCloseConnected,
                    onChange: (value: boolean) => settings.updateSettings({ confirmCloseConnected: value }),
                  },
                  // macOS only: Option-as-Meta blocks typing | [ ] { } @ \ ~
                  // with Option on many non-US keyboards.
                  ...(isMac
                    ? [
                        {
                          label: 'Option Key as Meta (turn off to type [ ] { } | @ with Option)',
                          value: settings.macOptionIsMeta,
                          onChange: (value: boolean) => settings.updateSettings({ macOptionIsMeta: value }),
                        },
                      ]
                    : []),
                ].map(({ label, value, onChange }) => (
                  <label
                    key={label}
                    className="flex items-center justify-between cursor-pointer py-1"
                  >
                    <span className="text-sm text-[var(--text-primary)]">{label}</span>
                    <div
                      onClick={() => onChange(!value)}
                      className="w-9 h-5 rounded-full transition-colors cursor-pointer relative"
                      style={{ background: value ? 'var(--accent)' : 'var(--border-strong)' }}
                    >
                      <div
                        className="absolute top-0.5 left-0.5 w-4 h-4 rounded-full bg-white shadow-sm transition-transform"
                        style={{ transform: value ? 'translateX(16px)' : 'translateX(0)' }}
                      />
                    </div>
                  </label>
                ))}
              </div>

              {/* Terminal ergonomics (W2-12): SecureCRT-style mouse behaviors,
                  opt-in. copy-on-select + right-click paste already live above;
                  middle-click paste is the new gate. */}
              <div className="mt-4">
                <label className="block text-xs text-[var(--text-secondary)] mb-1.5">
                  Terminal ergonomics
                </label>
                <div className="space-y-2">
                  <label className="flex items-center justify-between cursor-pointer py-1">
                    <span className="text-sm text-[var(--text-primary)]">Middle-Click Paste</span>
                    <div
                      onClick={() => settings.setMiddleClickPaste(!settings.middleClickPaste)}
                      className="w-9 h-5 rounded-full transition-colors cursor-pointer relative"
                      style={{ background: settings.middleClickPaste ? 'var(--accent)' : 'var(--border-strong)' }}
                    >
                      <div
                        className="absolute top-0.5 left-0.5 w-4 h-4 rounded-full bg-white shadow-sm transition-transform"
                        style={{ transform: settings.middleClickPaste ? 'translateX(16px)' : 'translateX(0)' }}
                      />
                    </div>
                  </label>
                </div>
                <p className="text-[11px] text-[var(--text-muted)] mt-1">
                  Paste the clipboard on middle-click (SecureCRT convention). Multi-line pastes still hit the paste guard.
                </p>
              </div>

              {/* Right-Click Behavior */}
              <div className="mt-4">
                <label className="block text-xs text-[var(--text-secondary)] mb-1.5">
                  Right-Click in Terminal
                </label>
                <div className="flex gap-1">
                  {(
                    [
                      { value: 'menu', label: 'Context Menu' },
                      { value: 'paste', label: 'Paste' },
                      { value: 'copyPaste', label: 'Copy / Paste' },
                    ] as const
                  ).map(({ value, label }) => (
                    <button
                      key={value}
                      onClick={() => settings.updateSettings({ rightClickBehavior: value })}
                      className={`
                        flex-1 py-1.5 text-xs rounded-md border transition-colors
                        ${
                          settings.rightClickBehavior === value
                            ? 'bg-[var(--bg-tertiary)] border-[var(--accent)] text-[var(--text-primary)]'
                            : 'bg-[var(--bg-primary)] border-[var(--border)] text-[var(--text-secondary)] hover:border-[var(--text-muted)]'
                        }
                      `}
                    >
                      {label}
                    </button>
                  ))}
                </div>
                <p className="text-[11px] text-[var(--text-muted)] mt-1">
                  Paste = PuTTY style. Copy / Paste = copy the selection if there is one, otherwise paste (Windows Terminal style).
                </p>
              </div>

              <div className="grid grid-cols-2 gap-3 mt-4">
                <div>
                  <label className="block text-xs text-[var(--text-secondary)] mb-1.5">
                    Paste Guard Threshold
                  </label>
                  <div className="flex items-center gap-2">
                    <input
                      type="range"
                      min={2}
                      max={25}
                      value={settings.pasteGuardLineThreshold}
                      onChange={(e) => settings.updateSettings({ pasteGuardLineThreshold: Number(e.target.value) })}
                      className="flex-1 accent-[var(--accent)]"
                    />
                    <span className="text-xs text-[var(--text-primary)] w-14 text-right">
                      {settings.pasteGuardLineThreshold} lines
                    </span>
                  </div>
                </div>

                <div>
                  <label className="block text-xs text-[var(--text-secondary)] mb-1.5">
                    Silence Alert Delay
                  </label>
                  <div className="flex items-center gap-2">
                    <input
                      type="range"
                      min={15}
                      max={300}
                      step={15}
                      value={settings.terminalSilenceThresholdSeconds}
                      onChange={(e) => settings.updateSettings({ terminalSilenceThresholdSeconds: Number(e.target.value) })}
                      className="flex-1 accent-[var(--accent)]"
                    />
                    <span className="text-xs text-[var(--text-primary)] w-12 text-right">
                      {settings.terminalSilenceThresholdSeconds}s
                    </span>
                  </div>
                </div>
              </div>
            </section>
          </Section>
          <Section id="device-profiles">
            <section id="set-device-profiles">
              <h3 className="text-sm font-semibold text-[var(--text-primary)] mb-3">
                Device Profiles
              </h3>
              <div className="space-y-3">
                <div className="grid grid-cols-[1fr_160px_auto] gap-2">
                  <input
                    value={profileName}
                    onChange={(e) => setProfileName(e.target.value)}
                    placeholder="Custom profile name"
                    className="input-field h-8 px-2 text-sm"
                  />
                  <select
                    value={profileBase}
                    onChange={(e) => setProfileBase(e.target.value as DeviceType)}
                    className="input-field h-8 px-2 text-sm"
                  >
                    {DEVICE_TYPES.map((dt) => (
                      <option key={dt.value} value={dt.value}>
                        {dt.short}
                      </option>
                    ))}
                  </select>
                  <button
                    onClick={addProfile}
                    className="px-3 h-8 rounded bg-[var(--bg-tertiary)] hover:bg-[var(--border-strong)] text-xs text-[var(--text-primary)]"
                  >
                    Add
                  </button>
                </div>
                <div className="flex items-center gap-2">
                  <button onClick={exportProfiles} className="px-2 py-1 rounded text-xs text-[var(--text-secondary)] hover:bg-[var(--bg-tertiary)]">
                    Export
                  </button>
                  <button onClick={importProfiles} className="px-2 py-1 rounded text-xs text-[var(--text-secondary)] hover:bg-[var(--bg-tertiary)]">
                    Import
                  </button>
                  <span className="text-[10px] text-[var(--text-muted)]">
                    {settings.customDeviceProfiles.length} custom profile{settings.customDeviceProfiles.length === 1 ? '' : 's'}
                  </span>
                </div>
                <div className="space-y-1">
                  {settings.customDeviceProfiles.length === 0 ? (
                    <p className="text-xs text-[var(--text-muted)]">
                      Create custom profiles here or from Map Device. Built-in profiles remain available automatically.
                    </p>
                  ) : (
                    settings.customDeviceProfiles.map((profile) => (
                      <div key={profile.id} className="flex items-center justify-between rounded-lg bg-[var(--bg-inset)] border border-[var(--border)] px-2 py-1.5">
                        <span className="text-xs text-[var(--text-primary)]">
                          {profile.name}
                          <span className="ml-2 text-[10px] text-[var(--text-muted)]">{profile.short}</span>
                        </span>
                        <button
                          onClick={() => settings.removeDeviceProfile(profile.id)}
                          className="text-[10px] text-[var(--accent-danger)] hover:underline"
                        >
                          Delete
                        </button>
                      </div>
                    ))
                  )}
                </div>
              </div>
            </section>
          </Section>
          <Section id="logins">
            <LoginProfiles />
          </Section>
          <Section id="connection">
            <section id="set-connection">
              <h3 className="text-sm font-semibold text-[var(--text-primary)] mb-3">
                Connection
              </h3>
              <div>
                <label className="block text-xs text-[var(--text-secondary)] mb-1.5">
                  Keep-Alive Interval (seconds)
                </label>
                <div className="flex items-center gap-2">
                  <input
                    type="range"
                    min={5}
                    max={120}
                    value={settings.keepAliveInterval}
                    onChange={(e) =>
                      settings.setKeepAliveInterval(Number(e.target.value))
                    }
                    className="flex-1 accent-[var(--accent)]"
                  />
                  <span className="text-sm text-[var(--text-primary)] w-8 text-right">
                    {settings.keepAliveInterval}
                  </span>
                </div>
              </div>
              <div className="flex items-center justify-between gap-3 mt-3 py-1">
                <div className="min-w-0">
                  <div className="text-sm text-[var(--text-primary)]">Auto Reconnect</div>
                  <div className="text-[11px] text-[var(--text-muted)]">
                    Reconnect a session that drops (link flap, device reload) without pressing Enter.
                  </div>
                </div>
                <Toggle on={settings.autoReconnect} onChange={settings.setAutoReconnect} label="Auto Reconnect" />
              </div>
            </section>
          </Section>
          <Section id="hosts">
            <div id="set-hosts">
              <HostsManager />
            </div>
          </Section>
          <Section id="tls">
            <section id="set-tls">
              <h3 className="text-sm font-semibold text-[var(--text-primary)] mb-3">Device REST security</h3>
              <label className="flex items-center justify-between cursor-pointer gap-3">
                <span className="min-w-0">
                  <span className="text-sm text-[var(--text-primary)]">Verify device TLS certificates</span>
                  <span className="block text-[10px] text-[var(--text-muted)]">
                    Reject untrusted/self-signed certs on AOS-CX / AOS-8 / AOS-S REST. On by
                    default — most field gear ships a self-signed cert, so turn it off only for
                    lab devices you trust.
                  </span>
                  {!settings.verifyDeviceTls && (
                    <span className="block text-[10px] text-[var(--accent-warning)] mt-1">
                      Device admin and SSH credentials can be intercepted on untrusted networks
                      when TLS verification is off. Disable only for self-signed lab devices.
                    </span>
                  )}
                </span>
                <div
                  onClick={() => settings.updateSettings({ verifyDeviceTls: !settings.verifyDeviceTls })}
                  className="w-9 h-5 rounded-full relative cursor-pointer transition-colors flex-shrink-0"
                  style={{ background: settings.verifyDeviceTls ? 'var(--accent)' : 'var(--border-strong)' }}
                  role="switch"
                  aria-checked={settings.verifyDeviceTls}
                  aria-label="Verify device TLS certificates"
                >
                  <div
                    className="absolute top-0.5 left-0.5 w-4 h-4 rounded-full bg-white shadow-sm transition-transform"
                    style={{ transform: settings.verifyDeviceTls ? 'translateX(16px)' : 'translateX(0)' }}
                  />
                </div>
              </label>
            </section>
          </Section>
          <Section id="triggers">
            <div id="set-triggers">
              <TriggersSettings />
            </div>
          </Section>
          <Section id="config-archive">
            <section id="set-config-archive">
              <h3 className="text-sm font-semibold text-[var(--text-primary)] mb-1.5">
                Config archive
              </h3>
              <p className="text-[11px] text-[var(--text-secondary)] mb-3">
                Snapshot the device running-config into archive history once on
                every ssh/telnet connect. Off by default; the manual{' '}
                {'"'}Capture now{'"'} button in the Config Archive panel is
                unaffected. This choice persists across app updates.
              </p>

              <label className="flex items-center justify-between cursor-pointer py-1">
                <span className="text-sm text-[var(--text-primary)]">Capture running-config on connect</span>
                <div
                  onClick={() => settings.setCaptureOnConnect(!settings.captureOnConnect)}
                  className="w-9 h-5 rounded-full transition-colors cursor-pointer relative"
                  style={{ background: settings.captureOnConnect ? 'var(--accent)' : 'var(--border-strong)' }}
                >
                  <div
                    className="absolute top-0.5 left-0.5 w-4 h-4 rounded-full bg-white shadow-sm transition-transform"
                    style={{ transform: settings.captureOnConnect ? 'translateX(16px)' : 'translateX(0)' }}
                  />
                </div>
              </label>
            </section>
          </Section>
          <Section id="intent-schedule">
            <section id="set-intent-schedule">
              <h3 className="text-sm font-semibold text-[var(--text-primary)] mb-1.5">
                Scheduled intent evaluation
              </h3>
              <p className="text-[11px] text-[var(--text-secondary)] mb-3">
                Re-run the intent-assurance sweep on an interval and alert on{' '}
                <em>new</em> violations only — a drift toast fires once per
                ok/unknown→violation transition, never on unchanged violations.
                Configure a webhook to get the same drift alerts off-box.
              </p>

              <label className="flex items-center justify-between cursor-pointer py-1">
                <span className="text-sm text-[var(--text-primary)]">Scheduled evaluation</span>
                <div
                  onClick={() => settings.setIntentScheduling(!settings.intentScheduling)}
                  className="w-9 h-5 rounded-full transition-colors cursor-pointer relative"
                  style={{ background: settings.intentScheduling ? 'var(--accent)' : 'var(--border-strong)' }}
                >
                  <div
                    className="absolute top-0.5 left-0.5 w-4 h-4 rounded-full bg-white shadow-sm transition-transform"
                    style={{ transform: settings.intentScheduling ? 'translateX(16px)' : 'translateX(0)' }}
                  />
                </div>
              </label>

              <div className="mt-3">
                <label className="block text-xs text-[var(--text-secondary)] mb-1.5">
                  Interval (minutes)
                </label>
                <div className="flex items-center gap-2">
                  <input
                    type="range"
                    min={1}
                    max={240}
                    step={5}
                    value={settings.intentScheduleMinutes}
                    onChange={(e) => settings.setIntentScheduleMinutes(Number(e.target.value))}
                    className="flex-1 accent-[var(--accent)]"
                  />
                  <span className="text-sm text-[var(--text-primary)] w-12 text-right">
                    {settings.intentScheduleMinutes}
                  </span>
                </div>
              </div>

              <div className="mt-3">
                <label className="block text-xs text-[var(--text-secondary)] mb-1.5">
                  Drift webhook URL (optional)
                </label>
                <input
                  type="url"
                  value={settings.intentWebhookUrl}
                  onChange={(e) => settings.setIntentWebhookUrl(e.target.value)}
                  placeholder="https://hooks.example.com/drift"
                  className="input-field w-full h-9 px-2.5 text-sm font-mono"
                />
                <p className="text-[10px] text-[var(--text-muted)] mt-1">
                  POSTed only on new-violation transitions ({'{'}event, count, violations{'}'}). Empty octets / failures are logged and skipped.
                </p>
              </div>
            </section>
          </Section>
          <Section id="logging">
            <SessionLogSettings />
          </Section>
          <Section id="ai">
            <section id="set-ai">
              <h3 className="text-sm font-semibold text-[var(--text-primary)] mb-3">
                AI Assistant
              </h3>
              <div className="space-y-3">
                {/* Provider selector */}
                <div>
                  <label className="block text-xs text-[var(--text-secondary)] mb-1.5">Provider</label>
                  <div className="grid grid-cols-3 gap-2">
                    {AI_PROVIDERS.map((p) => (
                      <button
                        key={p.value}
                        onClick={() => settings.setAiProvider(p.value)}
                        className={`py-2 text-[11px] rounded-lg border transition-colors ${
                          settings.aiProvider === p.value
                            ? 'bg-[var(--bg-tertiary)] border-[var(--accent)] text-[var(--text-primary)]'
                            : 'bg-[var(--bg-primary)] border-[var(--border)] text-[var(--text-secondary)] hover:border-[var(--text-muted)]'
                        }`}
                      >
                        {p.label}
                      </button>
                    ))}
                  </div>
                  {isCliProvider(aiProvider) && (
                    <p className="text-[11px] text-[var(--text-muted)] mt-2 leading-relaxed">
                      <strong className="text-[var(--text-secondary)]">
                        GreenCLI gives {aiProvider === 'casper' ? 'Casper' : 'Local CLI'} only your question
                      </strong>{' '}
                      (with the device name and your agent&apos;s instructions), not your SSH sessions, GreenCLI&apos;s
                      tools or GreenCLI&apos;s MCP servers. The Assistant tools switches below are not used.
                    </p>
                  )}
                </div>

                {aiProvider === 'casper' && <CasperSettings />}

                {/* Key-based providers: API key (stored in Rust, never in localStorage) */}
                {providerMeta?.needsKey && (
                  <div>
                    <label className="block text-xs text-[var(--text-secondary)] mb-1.5 flex items-center gap-1.5">
                      API Key
                      {keySaved && (
                        <>
                          <span className="flex items-center gap-1 text-[var(--accent-success)]">
                            <CheckCircle2 size={11} /> saved
                          </span>
                          <button
                            type="button"
                            onClick={() => {
                              invoke('ai_set_key', { provider: aiProvider, key: '' })
                                .then(() => {
                                  setKeySaved(false);
                                  setKeyInput('');
                                })
                                .catch(() => {});
                            }}
                            className="ml-auto text-[10px] text-[var(--text-muted)] hover:text-[var(--accent-danger)]"
                          >
                            remove
                          </button>
                        </>
                      )}
                    </label>
                    <div className="relative">
                      <input
                        type={showApiKey ? 'text' : 'password'}
                        value={keyInput}
                        onChange={(e) => setKeyInput(e.target.value)}
                        onBlur={saveKey}
                        placeholder={keySaved ? '•••••••• (saved — type to replace)' : 'Enter API key'}
                        className="w-full h-8 px-2 pr-8 bg-[var(--bg-primary)] border border-[var(--border)] rounded-lg text-sm text-[var(--text-primary)] placeholder-[var(--text-muted)] focus:outline-none focus:border-[var(--accent)] font-mono"
                      />
                      <button
                        type="button"
                        onClick={() => setShowApiKey(!showApiKey)}
                        className="absolute right-2 top-1/2 -translate-y-1/2 text-[var(--text-muted)] hover:text-[var(--text-secondary)]"
                      >
                        {showApiKey ? <EyeOff size={12} /> : <Eye size={12} />}
                      </button>
                    </div>
                    <p className="text-[10px] text-[var(--text-muted)] mt-1">
                      Stored in the app data dir (outside the browser), sent only to the provider from the Rust backend.
                    </p>
                  </div>
                )}

                {/* Model for key-based providers */}
                {providerMeta?.needsKey && aiProvider === 'anthropic' && (
                  <div>
                    <label className="block text-xs text-[var(--text-secondary)] mb-1.5">Model</label>
                    <select
                      value={settings.aiModel}
                      onChange={(e) => settings.setAiModel(e.target.value)}
                      className="w-full h-8 px-2 bg-[var(--bg-primary)] border border-[var(--border)] rounded-lg text-sm text-[var(--text-primary)] focus:outline-none focus:border-[var(--accent)]"
                    >
                      <option value="claude-sonnet-4-6">Claude Sonnet 4.6 (Recommended)</option>
                      <option value="claude-opus-4-8">Claude Opus 4.8 (Most capable)</option>
                      <option value="claude-haiku-4-5-20251001">Claude Haiku 4.5 (Fastest)</option>
                    </select>
                  </div>
                )}
                {aiProvider === 'openrouter' && (
                  <div>
                    <label className="block text-xs text-[var(--text-secondary)] mb-1.5">Model</label>
                    <input
                      type="text"
                      value={settings.openrouterModel}
                      onChange={(e) => settings.setOpenrouterModel(e.target.value)}
                      placeholder="e.g. anthropic/claude-3.5-sonnet"
                      className="w-full h-8 px-2 bg-[var(--bg-primary)] border border-[var(--border)] rounded-lg text-sm text-[var(--text-primary)] placeholder-[var(--text-muted)] focus:outline-none focus:border-[var(--accent)] font-mono"
                    />
                    <p className="text-[10px] text-[var(--text-muted)] mt-1">
                      Any OpenRouter model id (see openrouter.ai/models), e.g. <code className="text-[var(--text-primary)]">openai/gpt-4o</code>, <code className="text-[var(--text-primary)]">meta-llama/llama-3.1-70b-instruct</code>.
                    </p>
                  </div>
                )}
                {aiProvider === 'moonshot' && (
                  <div>
                    <label className="block text-xs text-[var(--text-secondary)] mb-1.5">Model</label>
                    <input
                      type="text"
                      value={settings.moonshotModel}
                      onChange={(e) => settings.setMoonshotModel(e.target.value)}
                      placeholder="e.g. kimi-k2-0905-preview"
                      className="w-full h-8 px-2 bg-[var(--bg-primary)] border border-[var(--border)] rounded-lg text-sm text-[var(--text-primary)] placeholder-[var(--text-muted)] focus:outline-none focus:border-[var(--accent)] font-mono"
                    />
                    <p className="text-[10px] text-[var(--text-muted)] mt-1">
                      A Moonshot/Kimi model id (see platform.moonshot.ai), e.g. <code className="text-[var(--text-primary)]">moonshot-v1-8k</code>.
                    </p>
                  </div>
                )}

                {/* Local CLI settings — no API key; the CLI handles its own login */}
                {aiProvider === 'local-cli' && (
                  <div>
                    <label className="block text-xs text-[var(--text-secondary)] mb-1.5">CLI Command</label>
                    <div className="flex gap-2 mb-2">
                      {AI_CLI_PRESETS.map((p) => (
                        <button
                          key={p.label}
                          onClick={() => settings.setLocalCliCommand(p.command)}
                          className={`flex-1 py-1.5 text-[11px] rounded-lg border transition-colors ${
                            settings.localCliCommand === p.command
                              ? 'bg-[var(--bg-tertiary)] border-[var(--accent)] text-[var(--text-primary)]'
                              : 'bg-[var(--bg-primary)] border-[var(--border)] text-[var(--text-secondary)] hover:border-[var(--text-muted)]'
                          }`}
                        >
                          {p.label}
                        </button>
                      ))}
                    </div>
                    <input
                      type="text"
                      value={settings.localCliCommand}
                      onChange={(e) => settings.setLocalCliCommand(e.target.value)}
                      placeholder="claude -p"
                      className="w-full h-8 px-2 bg-[var(--bg-primary)] border border-[var(--border)] rounded-lg text-sm text-[var(--text-primary)] placeholder-[var(--text-muted)] focus:outline-none focus:border-[var(--accent)] font-mono"
                    />
                    <p className="text-[10px] text-[var(--text-muted)] mt-1">
                      Runs a locally-installed CLI one-shot with the prompt on stdin — <span className="text-[var(--accent-success)]">no API key needed</span> (the CLI uses its own login). E.g. <code className="text-[var(--text-primary)]">claude -p</code> or <code className="text-[var(--text-primary)]">kimi</code>.
                    </p>
                    <p className="text-[10px] text-[var(--text-muted)] mt-1">
                      For <code className="text-[var(--text-primary)]">claude</code>, a fast model (<code className="text-[var(--text-primary)]">--model haiku</code>) and <code className="text-[var(--text-primary)]">--strict-mcp-config</code> (skip your MCP servers at startup) are added automatically — pass your own <code className="text-[var(--text-primary)]">--model</code> / <code className="text-[var(--text-primary)]">--mcp-config</code> to override.
                    </p>
                  </div>
                )}

                {/* Ollama settings */}
                {settings.aiProvider === 'ollama' && (
                  <>
                    <div>
                      <label className="block text-xs text-[var(--text-secondary)] mb-1.5">Ollama URL</label>
                      <input
                        type="text"
                        value={settings.ollamaUrl}
                        onChange={(e) => settings.setOllamaUrl(e.target.value)}
                        placeholder="http://localhost:11434"
                        className="w-full h-8 px-2 bg-[var(--bg-primary)] border border-[var(--border)] rounded-lg text-sm text-[var(--text-primary)] placeholder-[var(--text-muted)] focus:outline-none focus:border-[var(--accent)] font-mono"
                      />
                      {plainHttpWarning(settings.ollamaUrl || '', 'ollama') && (
                        <p className="text-[var(--accent-warning)] text-[10px] mt-1">
                          {plainHttpWarning(settings.ollamaUrl || '', 'ollama')}
                        </p>
                      )}
                    </div>
                    <div>
                      <label className="block text-xs text-[var(--text-secondary)] mb-1.5">Model</label>
                      <input
                        type="text"
                        value={settings.ollamaModel}
                        onChange={(e) => settings.setOllamaModel(e.target.value)}
                        placeholder="llama3.2"
                        className="w-full h-8 px-2 bg-[var(--bg-primary)] border border-[var(--border)] rounded-lg text-sm text-[var(--text-primary)] placeholder-[var(--text-muted)] focus:outline-none focus:border-[var(--accent)] font-mono"
                      />
                      <p className="text-[10px] text-[var(--text-muted)] mt-1">
                        Run <code className="text-[var(--text-primary)]">ollama list</code> to see installed models. Recommended: llama3.2, mistral, codellama
                      </p>
                    </div>
                  </>
                )}

                {/* Tool sources the assistant may use (opt-in beyond plain CLI) */}
                <div>
                  <label className="block text-xs text-[var(--text-secondary)] mb-1.5">
                    Assistant tools <span className="text-[var(--text-muted)]">(opt-in)</span>
                  </label>
                  <div
                    className={`space-y-2.5 rounded-[var(--radius)] border border-[var(--border)] bg-[var(--bg-inset)] p-2.5${
                      isCliProvider(aiProvider) ? ' opacity-60' : ''
                    }`}
                  >
                    {isCliProvider(aiProvider) && (
                      <p className="text-[11px] text-[var(--text-secondary)]">
                        Not used by {aiProvider === 'casper' ? 'Casper' : 'Local CLI'}. These apply when you pick
                        another provider.
                      </p>
                    )}
                    {(
                      [
                        { key: 'aiUseTerminal', label: 'Run device CLI commands', hint: 'Execute show/config on the active SSH/terminal session' },
                        { key: 'aiUseCxRest', label: 'Aruba device REST APIs', hint: 'On-box REST for CX / AOS-S / AOS-8 — structured data, no Central' },
                        { key: 'aiUseMcp', label: 'MCP server tools', hint: 'Tools from connected MCP servers (centralmcp, etc.)' },
                      ] as const
                    ).map(({ key, label, hint }) => {
                      const val = settings[key] as boolean;
                      return (
                        <label key={key} className="flex items-center justify-between cursor-pointer gap-3">
                          <span className="min-w-0">
                            <span className="text-sm text-[var(--text-primary)]">{label}</span>
                            <span className="block text-[10px] text-[var(--text-muted)] truncate">{hint}</span>
                          </span>
                          <div
                            onClick={() => settings.updateSettings({ [key]: !val } as Partial<TerminalSettings>)}
                            className="w-9 h-5 rounded-full relative cursor-pointer transition-colors flex-shrink-0"
                            style={{ background: val ? 'var(--accent)' : 'var(--border-strong)' }}
                          >
                            <div
                              className="absolute top-0.5 left-0.5 w-4 h-4 rounded-full bg-white shadow-sm transition-transform"
                              style={{ transform: val ? 'translateX(16px)' : 'translateX(0)' }}
                            />
                          </div>
                        </label>
                      );
                    })}
                  </div>
                </div>

                {/* References / standards — lightweight grounding for the AI */}
                <div>
                  <div className="flex items-center justify-between mb-1.5">
                    <label className="block text-xs text-[var(--text-secondary)]">
                      Best-practice references / standards
                    </label>
                    <button
                      onClick={() => {
                        if (settings.aiReferences.includes('Juniper Validated Design')) return;
                        const cur = settings.aiReferences.trimEnd();
                        settings.setAiReferences((cur ? cur + '\n\n' : '') + JVD_REFERENCES);
                      }}
                      className="text-[10px] px-2 py-0.5 rounded bg-[var(--bg-tertiary)] hover:bg-[var(--border-strong)] text-[var(--text-secondary)] hover:text-[var(--text-primary)]"
                      title="Append Juniper Validated Design best-practices"
                    >
                      + JVD best-practices
                    </button>
                  </div>
                  <textarea
                    value={settings.aiReferences}
                    onChange={(e) => settings.setAiReferences(e.target.value)}
                    rows={6}
                    placeholder="Add your org standards, golden-config rules, or doc links the AI should apply…"
                    className="w-full px-2 py-1.5 bg-[var(--bg-primary)] border border-[var(--border)] rounded-lg text-xs text-[var(--text-primary)] placeholder-[var(--text-muted)] focus:outline-none focus:border-[var(--accent)] font-mono resize-y"
                  />
                  <p className="text-[10px] text-[var(--text-muted)] mt-1">
                    Injected into the AI's context (used by the Best-practices audit). Lightweight
                    alternative to RAG — paste rules or links here; a hosted RAG endpoint can feed
                    this same field later.
                  </p>
                </div>
              </div>
            </section>
          </Section>
          <Section id="agents">
            <AiAgents />
          </Section>
          <Section id="mcp">
            <div id="set-mcp">
              <McpServers />
            </div>
          </Section>
          <Section id="central">
            <div id="set-central">
              <CentralSettings />
            </div>
          </Section>
          <Section id="mist">
            <section id="set-mist">
              <h3 className="text-sm font-semibold text-[var(--text-primary)] mb-3">Juniper Mist</h3>
              <div className="space-y-3">
                <div>
                  <label className="block text-xs text-[var(--text-secondary)] mb-1.5">API base (region)</label>
                  <input
                    value={settings.mistBaseUrl}
                    onChange={(e) => settings.updateSettings({ mistBaseUrl: e.target.value })}
                    placeholder="https://api.mist.com  (or api.eu.mist.com, api.gc1.mist.com …)"
                    className="input-field w-full h-8 px-2 text-sm font-mono"
                  />
                </div>
                <div>
                  <label className="block text-xs text-[var(--text-secondary)] mb-1.5">API token</label>
                  <input
                    type="password"
                    value={settings.mistToken}
                    onChange={(e) => settings.updateSettings({ mistToken: e.target.value })}
                    placeholder="Mist API token"
                    className="input-field w-full h-8 px-2 text-sm font-mono"
                  />
                </div>
                <p className="text-[10px] text-[var(--text-muted)]">
                  Mist cloud REST (token auth). Create a token in the Mist portal (My Account → API Tokens).
                  Use it from the <strong>API Explorer → Mist</strong> target.
                </p>
              </div>
            </section>
          </Section>
          <Section id="backup">
            <section id="set-backup">
              <h3 className="text-sm font-semibold text-[var(--text-primary)] mb-2">
                Backup &amp; Transfer
              </h3>
              <p className="text-xs text-[var(--text-muted)] mb-3">
                Export settings, snippets, device profiles, saved sessions, triggers, and intents. Secrets and vault data are never included.
              </p>
              <div className="flex items-center gap-2 mb-3">
                {(['merge', 'replace'] as BackupImportMode[]).map((mode) => (
                  <button
                    key={mode}
                    onClick={() => setBackupMode(mode)}
                    className={`px-2.5 py-1 rounded-md text-xs border capitalize transition-colors ${
                      backupMode === mode
                        ? 'border-[var(--accent)] text-[var(--accent)] bg-[var(--accent-soft)]'
                        : 'border-[var(--border)] text-[var(--text-secondary)] hover:border-[var(--border-strong)]'
                    }`}
                    title={mode === 'merge' ? 'Add/update backup items without deleting local data' : 'Replace supported local data with the backup'}
                  >
                    {mode}
                  </button>
                ))}
                <span className="text-[10px] text-[var(--text-muted)]">
                  {backupMode === 'merge' ? 'Import adds or updates matching IDs.' : 'Import clears supported local data first.'}
                </span>
              </div>
              <div className="flex items-center gap-2">
                <button
                  onClick={exportBackup}
                  disabled={backupBusy !== null}
                  className="flex items-center gap-1.5 px-3 h-8 rounded bg-[var(--bg-tertiary)] hover:bg-[var(--border-strong)] disabled:opacity-50 text-xs text-[var(--text-primary)]"
                >
                  <Download size={13} />
                  {backupBusy === 'export' ? 'Exporting…' : 'Export backup'}
                </button>
                <button
                  onClick={importBackup}
                  disabled={backupBusy !== null}
                  className="flex items-center gap-1.5 px-3 h-8 rounded bg-[var(--bg-tertiary)] hover:bg-[var(--border-strong)] disabled:opacity-50 text-xs text-[var(--text-primary)]"
                >
                  <Upload size={13} />
                  {backupBusy === 'import' ? 'Importing…' : 'Import backup'}
                </button>
              </div>
            </section>
          </Section>
          <Section id="reset">
            {/* Reset lives here, next to Export, instead of in the Settings
                header beside the close X — where it was easy to hit by mistake
                and read like an app "reset". */}
            <section id="set-reset">
              <h3 className="text-sm font-semibold text-[var(--accent-danger)] mb-2">
                Reset Settings
              </h3>
              <p className="text-xs text-[var(--text-muted)] mb-3">
                Puts every setting back to its default: theme and terminal options,
                custom device profiles, AI agents and providers, and Central / Mist
                accounts. Saved sessions, shared logins, snippets, the vault and open
                tabs are not touched. Export a backup first if you might want them back.
              </p>
              <button
                onClick={async () => {
                  const ok = await askConfirm({
                    title: 'Reset all settings to defaults?',
                    message:
                      'Theme and terminal options, custom device profiles, AI agents and providers, and Central / Mist accounts all go back to defaults. Saved sessions and the vault are kept. This cannot be undone.',
                    confirmLabel: 'Reset settings',
                    danger: true,
                  });
                  if (ok) settings.resetToDefaults();
                }}
                className="flex items-center gap-1.5 px-3 h-8 rounded border border-[var(--accent-danger)] text-[var(--accent-danger)] hover:bg-[var(--bg-tertiary)] text-xs"
              >
                <RotateCcw size={13} />
                Reset all settings…
              </button>
            </section>
          </Section>
        </SectionVisibility.Provider>
      </div>
    </LargeModal>
  );
}
