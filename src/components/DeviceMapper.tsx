import { useEffect, useMemo, useState } from 'react';
import { X, Wand2, CheckCircle2, Download, Upload } from 'lucide-react';
import { invoke } from '@tauri-apps/api/tauri';
import { open as openDialog, save as saveDialog } from '@tauri-apps/api/dialog';
import { useSessionStore } from '../store/sessionStore';
import { useSettingsStore } from '../store/settingsStore';
import { DeviceProfile, DeviceType, DEVICE_TYPES } from '../types';
import { generateId } from '../utils';
import {
  allDeviceProfiles,
  detectProfileFromOutput,
  deviceTypeLabel,
  profileReason,
  sanitizeStandaloneImportedProfiles,
  saveSessionPayload,
} from '../utils/deviceProfiles';
import { notify } from '../store/toastStore';

interface DeviceMapperProps {
  sessionId: string | null;
  onClose: () => void;
}

const isTauri = typeof window !== 'undefined' && '__TAURI__' in window;

function lastPrompt(output: string): string {
  return output
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .slice(-8)
    .find((line) => /[#>]\s?$/.test(line)) ?? '';
}

export default function DeviceMapper({ sessionId, onClose }: DeviceMapperProps) {
  const { sessions, folders, updateSessionConfig } = useSessionStore();
  const settings = useSettingsStore();
  const session = sessions.find((s) => s.sessionId === sessionId);
  const profiles = useMemo(
    () => allDeviceProfiles(settings.customDeviceProfiles),
    [settings.customDeviceProfiles],
  );
  const [output, setOutput] = useState('');
  const [selectedProfileId, setSelectedProfileId] = useState('builtin-generic');
  const [customName, setCustomName] = useState('');
  const [customBase, setCustomBase] = useState<DeviceType>('generic');

  useEffect(() => {
    if (!sessionId) return;
    invoke<string>('get_terminal_output', { sessionId })
      .then((tail) => {
        setOutput(tail);
        const suggestion = detectProfileFromOutput(tail, settings.customDeviceProfiles);
        setSelectedProfileId(suggestion.id);
        setCustomBase(suggestion.deviceType);
      })
      .catch(() => {
        setOutput('');
        setSelectedProfileId(session?.config.deviceProfileId || 'builtin-generic');
      });
  }, [sessionId, session?.config.deviceProfileId, settings.customDeviceProfiles]);

  if (!sessionId || !session) return null;

  const selectedProfile = profiles.find((p) => p.id === selectedProfileId) ?? profiles[0];
  const reason = profileReason(selectedProfile, output);

  const persistMapping = async (profile: DeviceProfile) => {
    const updates = {
      deviceType: profile.deviceType,
      deviceProfileId: profile.id,
      startupCommands: session.config.startupCommands || profile.startupCommands,
    };
    const folder = folders.find((f) => f.items.some((item) => item.id === session.config.id));
    const savedItem = folder?.items.find((item) => item.id === session.config.id);
    const nextConfig = {
      ...(savedItem ?? {}),
      ...session.config,
      tags: savedItem?.tags ?? session.config.tags,
      ...updates,
    };
    updateSessionConfig(sessionId, updates);
    settings.setLastUsedDeviceType(profile.deviceType);
    settings.setLastUsedDeviceProfileId(profile.id);

    if (folder) {
      await invoke('save_session', {
        config: saveSessionPayload(nextConfig),
        folderId: folder.id,
      }).catch((e) => notify.warning('Mapping saved only for this open tab', String(e)));
    }
    notify.success('Device mapped', `${session.config.name || session.config.host || 'Session'} now uses ${profile.name}.`);
    onClose();
  };

  const createCustomProfile = () => {
    const name = customName.trim();
    if (!name) {
      notify.warning('Name required', 'Enter a name for the custom profile.');
      return;
    }
    const base = profiles.find((p) => p.deviceType === customBase) ?? profiles[0];
    const prompt = lastPrompt(output);
    const profile: DeviceProfile = {
      ...base,
      id: `custom-${generateId()}`,
      name,
      deviceType: customBase,
      short: name.slice(0, 6).toUpperCase(),
      description: `Custom profile based on ${deviceTypeLabel(customBase)}.`,
      promptPatterns: prompt ? [`^${prompt.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`] : base.promptPatterns,
      fingerprints: prompt ? [prompt] : base.fingerprints,
    };
    settings.addDeviceProfile(profile);
    setSelectedProfileId(profile.id);
    setCustomName('');
    notify.success('Custom profile created', `${profile.name} is available for mapping and Quick Connect.`);
  };

  const exportProfiles = async () => {
    const data = JSON.stringify(settings.customDeviceProfiles, null, 2);
    if (isTauri) {
      const path = await saveDialog({
        title: 'Export device profiles',
        defaultPath: 'greencli-device-profiles.json',
        filters: [{ name: 'JSON', extensions: ['json'] }],
      });
      if (path) await invoke('write_file_text', { path, contents: data });
    } else {
      const blob = new Blob([data], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = 'greencli-device-profiles.json';
      a.click();
      URL.revokeObjectURL(url);
    }
  };

  const importProfiles = async () => {
    try {
      let text = '';
      if (isTauri) {
        const picked = await openDialog({
          title: 'Import device profiles',
          multiple: false,
          filters: [{ name: 'JSON', extensions: ['json'] }],
        });
        if (typeof picked !== 'string') return;
        text = await invoke<string>('read_file_text', { path: picked });
      } else {
        const input = document.createElement('input');
        input.type = 'file';
        input.accept = 'application/json';
        text = await new Promise<string>((resolve) => {
          input.onchange = () => {
            const file = input.files?.[0];
            if (!file) return resolve('');
            const reader = new FileReader();
            reader.onload = () => resolve(String(reader.result || ''));
            reader.onerror = () => resolve('');
            reader.readAsText(file);
          };
          input.click();
        });
      }
      if (!text) return;
      const parsed = sanitizeStandaloneImportedProfiles(JSON.parse(text));
      parsed.forEach((profile) => settings.addDeviceProfile(profile));
      notify.success('Profiles imported', `${parsed.length} profile${parsed.length === 1 ? '' : 's'} added.`);
    } catch (e) {
      notify.error('Import failed', String(e));
    }
  };

  return (
    <div className="fixed inset-0 z-[70] flex items-center justify-center bg-black/55 backdrop-blur-sm">
      <div className="w-[620px] max-w-[94vw] max-h-[86vh] overflow-hidden surface-elevated flex flex-col">
        <div className="flex items-center justify-between px-5 py-4 border-b border-[var(--border)]">
          <div className="flex items-center gap-2">
            <Wand2 size={17} className="text-[var(--accent)]" />
            <div>
              <h2 className="text-[16px] font-semibold text-[var(--text-primary)]">Map Device</h2>
              <p className="text-[11px] text-[var(--text-muted)]">
                {session.config.name || session.config.host || 'Current session'}
              </p>
            </div>
          </div>
          <button onClick={onClose} className="p-1.5 rounded hover:bg-[var(--bg-tertiary)] text-[var(--text-secondary)]">
            <X size={17} />
          </button>
        </div>

        <div className="flex-1 overflow-y-auto p-5 space-y-4">
          <div className="rounded-lg border border-[var(--border)] bg-[var(--bg-inset)] p-3">
            <div className="flex items-start gap-2">
              <CheckCircle2 size={16} className="mt-0.5 text-[var(--accent-success)]" />
              <div>
                <p className="text-sm text-[var(--text-primary)]">Suggested mapping: {selectedProfile.name}</p>
                <p className="text-xs text-[var(--text-muted)] mt-1">{reason}</p>
              </div>
            </div>
          </div>

          <div>
            <label className="block text-[11px] font-semibold uppercase tracking-wide text-[var(--text-secondary)] mb-2">
              Choose profile
            </label>
            <div className="grid grid-cols-2 gap-2">
              {profiles.map((profile) => (
                <button
                  key={profile.id}
                  onClick={() => setSelectedProfileId(profile.id)}
                  className={`text-left rounded-lg border px-3 py-2 transition-colors ${
                    selectedProfileId === profile.id
                      ? 'border-[var(--accent)] bg-[var(--accent-soft)]'
                      : 'border-[var(--border)] bg-[var(--bg-inset)] hover:border-[var(--border-strong)]'
                  }`}
                >
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-sm font-medium text-[var(--text-primary)]">{profile.name}</span>
                    <span className="text-[10px] text-[var(--text-muted)]">{profile.short}</span>
                  </div>
                  <p className="text-[10px] text-[var(--text-muted)] mt-1 truncate">
                    {profile.description || deviceTypeLabel(profile.deviceType)}
                  </p>
                </button>
              ))}
            </div>
          </div>

          <div className="rounded-lg border border-[var(--border)] bg-[var(--bg-secondary)] p-3 space-y-2">
            <label className="block text-[11px] font-semibold uppercase tracking-wide text-[var(--text-secondary)]">
              Create custom profile from this device
            </label>
            <div className="grid grid-cols-[1fr_180px_auto] gap-2">
              <input
                value={customName}
                onChange={(e) => setCustomName(e.target.value)}
                placeholder="Profile name"
                className="input-field h-8 px-2 text-sm"
              />
              <select
                value={customBase}
                onChange={(e) => setCustomBase(e.target.value as DeviceType)}
                className="input-field h-8 px-2 text-sm"
              >
                {DEVICE_TYPES.map((dt) => (
                  <option key={dt.value} value={dt.value}>
                    {dt.label}
                  </option>
                ))}
              </select>
              <button
                onClick={createCustomProfile}
                className="px-3 h-8 rounded bg-[var(--bg-tertiary)] hover:bg-[var(--border-strong)] text-xs text-[var(--text-primary)]"
              >
                Add
              </button>
            </div>
            <div className="flex items-center gap-2">
              <button onClick={exportProfiles} className="flex items-center gap-1 px-2 py-1 rounded text-xs text-[var(--text-secondary)] hover:bg-[var(--bg-tertiary)]">
                <Download size={12} /> Export profiles
              </button>
              <button onClick={importProfiles} className="flex items-center gap-1 px-2 py-1 rounded text-xs text-[var(--text-secondary)] hover:bg-[var(--bg-tertiary)]">
                <Upload size={12} /> Import profiles
              </button>
            </div>
          </div>

          <div>
            <label className="block text-[11px] font-semibold uppercase tracking-wide text-[var(--text-secondary)] mb-2">
              Recent output sample
            </label>
            <pre className="max-h-32 overflow-auto rounded-lg bg-[var(--bg-inset)] border border-[var(--border)] p-2 text-[10px] text-[var(--text-muted)] whitespace-pre-wrap">
              {output.trim().slice(-2000) || 'No recent terminal output captured yet.'}
            </pre>
          </div>
        </div>

        <div className="flex justify-end gap-2 px-5 py-4 border-t border-[var(--border)]">
          <button onClick={onClose} className="px-3 py-1.5 rounded text-sm text-[var(--text-secondary)] hover:bg-[var(--bg-tertiary)]">
            Cancel
          </button>
          <button onClick={() => persistMapping(selectedProfile)} className="btn-accent px-4 py-1.5 text-sm">
            Apply mapping
          </button>
        </div>
      </div>
    </div>
  );
}
