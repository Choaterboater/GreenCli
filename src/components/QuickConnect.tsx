import { useState } from 'react';
import { X, Plug, Monitor, Server, Wifi, Router, TerminalSquare } from 'lucide-react';
import { useSessionStore } from '../store/sessionStore';
import { ConnectionConfig, Protocol, PROTOCOLS, DEVICE_TYPES, LOCAL_CLI_PRESETS } from '../types';
import { generateId } from '../utils';
import { invoke } from '@tauri-apps/api/tauri';

const deviceIcons: Record<string, React.ReactNode> = {
  'aruba-cx': <Server size={16} />,
  'aruba-ap': <Wifi size={16} />,
  'aruba-controller': <Router size={16} />,
  generic: <Monitor size={16} />,
};

interface QuickConnectProps {
  onConnect: (config: ConnectionConfig) => void;
}

export default function QuickConnect({ onConnect }: QuickConnectProps) {
  const { showQuickConnect, setShowQuickConnect } = useSessionStore();
  const [protocol, setProtocol] = useState<Protocol>('ssh');
  const [host, setHost] = useState('');
  const [port, setPort] = useState(22);
  const [username, setUsername] = useState('');
  const [deviceType, setDeviceType] =
    useState<ConnectionConfig['deviceType']>('aruba-cx');
  const [serialPort, setSerialPort] = useState('');
  const [baudRate, setBaudRate] = useState(9600);
  const [cliPresetId, setCliPresetId] = useState('shell');
  const [customCommand, setCustomCommand] = useState('');
  const [saveSession, setSaveSession] = useState(false);
  const [connecting, setConnecting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (!showQuickConnect) return null;

  const isHostBased = protocol === 'ssh' || protocol === 'telnet';

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setConnecting(true);

    try {
      const preset = LOCAL_CLI_PRESETS.find((p) => p.id === cliPresetId);
      const localCommand =
        protocol === 'local'
          ? customCommand.trim() || preset?.command
          : undefined;
      const localName =
        protocol === 'local'
          ? (preset && preset.id !== 'shell' ? preset.label : localCommand || 'Local Shell')
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
        deviceType: protocol === 'local' ? 'generic' : deviceType,
        command: localCommand,
        args: protocol === 'local' ? preset?.args : undefined,
      };

      if (saveSession) {
        await invoke('save_session', {
          config: {
            id: config.id,
            name: config.name,
            protocol: config.protocol,
            host: config.host,
            port: config.port,
            username: config.username,
            auth_type: config.authType || 'password',
            device_type: config.deviceType,
            serial_port: config.serialPort,
            baud_rate: config.baudRate,
          },
          folderId: 'default',
        }).catch(() => {});
      }

      await onConnect(config);
      setShowQuickConnect(false);
      setHost('');
      setPort(22);
      setUsername('');
      setSaveSession(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setConnecting(false);
    }
  };

  const handleProtocolChange = (p: typeof protocol) => {
    setProtocol(p);
    setPort(p === 'ssh' ? 22 : p === 'telnet' ? 23 : 9600);
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm">
      <div className="w-[480px] bg-[#161b22] border border-[#30363d] rounded-xl shadow-2xl">
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-4 border-b border-[#21262d]">
          <h2 className="text-lg font-semibold text-[#c9d1d9]">
            Quick Connect
          </h2>
          <button
            onClick={() => setShowQuickConnect(false)}
            className="p-1 rounded hover:bg-[#21262d] text-[#8b949e] hover:text-[#c9d1d9]"
          >
            <X size={18} />
          </button>
        </div>

        {/* Form */}
        <form onSubmit={handleSubmit} className="px-5 py-4 space-y-4">
          {/* Protocol */}
          <div>
            <label className="block text-xs font-medium text-[#8b949e] mb-1.5">
              Protocol
            </label>
            <div className="flex gap-2">
              {PROTOCOLS.map((p) => (
                <button
                  key={p.value}
                  type="button"
                  onClick={() => handleProtocolChange(p.value)}
                  className={`
                    flex-1 py-2 text-sm rounded-lg border transition-all
                    ${
                      protocol === p.value
                        ? 'bg-[#238636] border-[#238636] text-white'
                        : 'bg-[#0d1117] border-[#30363d] text-[#8b949e] hover:border-[#58a6ff] hover:text-[#c9d1d9]'
                    }
                  `}
                >
                  {p.label}
                </button>
              ))}
            </div>
          </div>

          {/* Host / Serial Port */}
          <div className="grid grid-cols-3 gap-3">
            {isHostBased ? (
              <>
                <div className="col-span-2">
                  <label className="block text-xs font-medium text-[#8b949e] mb-1.5">
                    Host
                  </label>
                  <input
                    type="text"
                    value={host}
                    onChange={(e) => setHost(e.target.value)}
                    placeholder="192.168.1.1"
                    required
                    className="w-full h-9 px-3 bg-[#0d1117] border border-[#30363d] rounded-lg text-sm text-[#c9d1d9] placeholder-[#484f58] focus:outline-none focus:border-[#58a6ff]"
                  />
                </div>
                <div>
                  <label className="block text-xs font-medium text-[#8b949e] mb-1.5">
                    Port
                  </label>
                  <input
                    type="number"
                    value={port}
                    onChange={(e) => setPort(Number(e.target.value))}
                    min={1}
                    max={65535}
                    className="w-full h-9 px-3 bg-[#0d1117] border border-[#30363d] rounded-lg text-sm text-[#c9d1d9] focus:outline-none focus:border-[#58a6ff]"
                  />
                </div>
              </>
            ) : protocol === 'serial' ? (
              <>
                <div className="col-span-2">
                  <label className="block text-xs font-medium text-[#8b949e] mb-1.5">
                    Serial Port
                  </label>
                  <input
                    type="text"
                    value={serialPort}
                    onChange={(e) => setSerialPort(e.target.value)}
                    placeholder="/dev/ttyUSB0"
                    required
                    className="w-full h-9 px-3 bg-[#0d1117] border border-[#30363d] rounded-lg text-sm text-[#c9d1d9] placeholder-[#484f58] focus:outline-none focus:border-[#58a6ff]"
                  />
                </div>
                <div>
                  <label className="block text-xs font-medium text-[#8b949e] mb-1.5">
                    Baud Rate
                  </label>
                  <select
                    value={baudRate}
                    onChange={(e) => setBaudRate(Number(e.target.value))}
                    className="w-full h-9 px-3 bg-[#0d1117] border border-[#30363d] rounded-lg text-sm text-[#c9d1d9] focus:outline-none focus:border-[#58a6ff]"
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

          {/* Local Shell / CLI */}
          {protocol === 'local' && (
            <div className="space-y-3">
              <div>
                <label className="block text-xs font-medium text-[#8b949e] mb-1.5">
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
                      className={`flex flex-col items-center gap-1 py-2.5 rounded-lg border transition-all ${
                        cliPresetId === p.id && !customCommand
                          ? 'bg-[#1c4f3e] border-[#238636] text-[#3fb950]'
                          : 'bg-[#0d1117] border-[#30363d] text-[#8b949e] hover:border-[#58a6ff]'
                      }`}
                    >
                      <TerminalSquare size={16} />
                      <span className="text-[10px] font-medium">{p.label}</span>
                    </button>
                  ))}
                </div>
              </div>
              <div>
                <label className="block text-xs font-medium text-[#8b949e] mb-1.5">
                  Custom command (optional)
                </label>
                <input
                  type="text"
                  value={customCommand}
                  onChange={(e) => setCustomCommand(e.target.value)}
                  placeholder="e.g. gh copilot — overrides the preset above"
                  className="w-full h-9 px-3 bg-[#0d1117] border border-[#30363d] rounded-lg text-sm text-[#c9d1d9] placeholder-[#484f58] focus:outline-none focus:border-[#58a6ff]"
                />
              </div>
            </div>
          )}

          {/* Username */}
          {isHostBased && (
            <div>
              <label className="block text-xs font-medium text-[#8b949e] mb-1.5">
                Username
              </label>
              <input
                type="text"
                value={username}
                onChange={(e) => setUsername(e.target.value)}
                placeholder="admin"
                className="w-full h-9 px-3 bg-[#0d1117] border border-[#30363d] rounded-lg text-sm text-[#c9d1d9] placeholder-[#484f58] focus:outline-none focus:border-[#58a6ff]"
              />
            </div>
          )}

          {/* Device Type */}
          {protocol !== 'local' && (
          <div>
            <label className="block text-xs font-medium text-[#8b949e] mb-1.5">
              Device Type
            </label>
            <div className="grid grid-cols-4 gap-2">
              {DEVICE_TYPES.map((dt) => (
                <button
                  key={dt.value}
                  type="button"
                  onClick={() => setDeviceType(dt.value)}
                  className={`
                    flex flex-col items-center gap-1 py-2.5 rounded-lg border transition-all
                    ${
                      deviceType === dt.value
                        ? 'bg-[#1c4f3e] border-[#238636] text-[#3fb950]'
                        : 'bg-[#0d1117] border-[#30363d] text-[#8b949e] hover:border-[#58a6ff]'
                    }
                  `}
                >
                  {deviceIcons[dt.value]}
                  <span className="text-[10px] font-medium">{dt.label}</span>
                </button>
              ))}
            </div>
          </div>
          )}

          {/* Save to Sidebar */}
          <label className="flex items-center gap-2 cursor-pointer select-none">
            <input
              type="checkbox"
              checked={saveSession}
              onChange={(e) => setSaveSession(e.target.checked)}
              className="w-4 h-4 rounded accent-[#238636]"
            />
            <span className="text-sm text-[#8b949e]">Save to Sidebar</span>
          </label>

          {/* Error */}
          {error && (
            <div className="px-3 py-2 bg-[#3d1518] border border-[#ff7b72]/30 rounded-lg text-sm text-[#ff7b72]">
              {error}
            </div>
          )}

          {/* Actions */}
          <div className="flex items-center gap-3 pt-2">
            <button
              type="button"
              onClick={() => setShowQuickConnect(false)}
              className="flex-1 h-9 text-sm bg-[#21262d] hover:bg-[#30363d] text-[#c9d1d9] rounded-lg transition-colors"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={connecting || (isHostBased && !host) || (protocol === 'serial' && !serialPort)}
              className="flex-1 flex items-center justify-center gap-2 h-9 text-sm bg-[#238636] hover:bg-[#2ea043] disabled:bg-[#1c4f3e] disabled:text-[#484f58] text-white rounded-lg transition-colors"
            >
              <Plug size={14} />
              {connecting ? 'Connecting...' : 'Connect'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
