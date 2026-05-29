import { useState } from 'react';
import { X, KeyRound, Eye, EyeOff, Lock } from 'lucide-react';
import { useSessionStore } from '../store/sessionStore';

interface SshAuthDialogProps {
  onAuthenticate: (password: string, saveCredential: boolean) => void;
}

export default function SshAuthDialog({ onAuthenticate }: SshAuthDialogProps) {
  const { showAuthDialog, pendingConnection, setShowAuthDialog } = useSessionStore();
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [saveCredential, setSaveCredential] = useState(false);
  const [authType, setAuthType] = useState<'password' | 'key'>('password');
  const [privateKey, setPrivateKey] = useState('');
  const [keyPassphrase, setKeyPassphrase] = useState('');
  const [showKeyPassphrase, setShowKeyPassphrase] = useState(false);

  if (!showAuthDialog || !pendingConnection) return null;

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (authType === 'password') {
      onAuthenticate(password, saveCredential);
    } else {
      // Key-based auth
      onAuthenticate(privateKey, saveCredential);
    }
    setPassword('');
    setPrivateKey('');
    setKeyPassphrase('');
    setShowAuthDialog(false);
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm">
      <div className="w-[420px] bg-[#161b22] border border-[#30363d] rounded-xl shadow-2xl">
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-4 border-b border-[#21262d]">
          <div className="flex items-center gap-2">
            <KeyRound size={18} className="text-[#58a6ff]" />
            <h2 className="text-lg font-semibold text-[#c9d1d9]">
              Authentication
            </h2>
          </div>
          <button
            onClick={() => setShowAuthDialog(false)}
            className="p-1 rounded hover:bg-[#21262d] text-[#8b949e] hover:text-[#c9d1d9]"
          >
            <X size={18} />
          </button>
        </div>

        {/* Target Info */}
        <div className="px-5 py-3 bg-[#0d1117] border-b border-[#21262d]">
          <div className="flex items-center gap-2 text-sm">
            <span className="text-[#8b949e]">Connecting to</span>
            <span className="text-[#58a6ff] font-mono">
              {pendingConnection.username
                ? `${pendingConnection.username}@`
                : ''}
              {pendingConnection.host}
              {pendingConnection.port && pendingConnection.port !== 22
                ? `:${pendingConnection.port}`
                : ''}
            </span>
          </div>
        </div>

        <form onSubmit={handleSubmit} className="px-5 py-4 space-y-4">
          {/* Auth Type Tabs */}
          <div className="flex gap-1 p-1 bg-[#0d1117] rounded-lg">
            <button
              type="button"
              onClick={() => setAuthType('password')}
              className={`
                flex-1 py-1.5 text-sm rounded-md transition-colors
                ${
                  authType === 'password'
                    ? 'bg-[#21262d] text-[#c9d1d9]'
                    : 'text-[#8b949e] hover:text-[#c9d1d9]'
                }
              `}
            >
              Password
            </button>
            <button
              type="button"
              onClick={() => setAuthType('key')}
              className={`
                flex-1 py-1.5 text-sm rounded-md transition-colors
                ${
                  authType === 'key'
                    ? 'bg-[#21262d] text-[#c9d1d9]'
                    : 'text-[#8b949e] hover:text-[#c9d1d9]'
                }
              `}
            >
              Private Key
            </button>
          </div>

          {authType === 'password' ? (
            <div>
              <label className="block text-xs font-medium text-[#8b949e] mb-1.5">
                Password
              </label>
              <div className="relative">
                <input
                  type={showPassword ? 'text' : 'password'}
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  autoFocus
                  required
                  className="w-full h-9 pl-3 pr-10 bg-[#0d1117] border border-[#30363d] rounded-lg text-sm text-[#c9d1d9] focus:outline-none focus:border-[#58a6ff]"
                />
                <button
                  type="button"
                  onClick={() => setShowPassword(!showPassword)}
                  className="absolute right-2 top-1/2 -translate-y-1/2 p-1 text-[#8b949e] hover:text-[#c9d1d9]"
                >
                  {showPassword ? <EyeOff size={14} /> : <Eye size={14} />}
                </button>
              </div>
            </div>
          ) : (
            <div className="space-y-3">
              <div>
                <label className="block text-xs font-medium text-[#8b949e] mb-1.5">
                  Private Key (PEM)
                </label>
                <textarea
                  value={privateKey}
                  onChange={(e) => setPrivateKey(e.target.value)}
                  placeholder="-----BEGIN OPENSSH PRIVATE KEY-----"
                  rows={4}
                  required
                  className="w-full px-3 py-2 bg-[#0d1117] border border-[#30363d] rounded-lg text-sm text-[#c9d1d9] placeholder-[#484f58] focus:outline-none focus:border-[#58a6ff] font-mono resize-none"
                />
              </div>
              <div>
                <label className="block text-xs font-medium text-[#8b949e] mb-1.5">
                  Key Passphrase (optional)
                </label>
                <div className="relative">
                  <input
                    type={showKeyPassphrase ? 'text' : 'password'}
                    value={keyPassphrase}
                    onChange={(e) => setKeyPassphrase(e.target.value)}
                    className="w-full h-9 pl-3 pr-10 bg-[#0d1117] border border-[#30363d] rounded-lg text-sm text-[#c9d1d9] focus:outline-none focus:border-[#58a6ff]"
                  />
                  <button
                    type="button"
                    onClick={() => setShowKeyPassphrase(!showKeyPassphrase)}
                    className="absolute right-2 top-1/2 -translate-y-1/2 p-1 text-[#8b949e] hover:text-[#c9d1d9]"
                  >
                    {showKeyPassphrase ? (
                      <EyeOff size={14} />
                    ) : (
                      <Eye size={14} />
                    )}
                  </button>
                </div>
              </div>
            </div>
          )}

          {/* Save Credential */}
          <label className="flex items-center gap-2 cursor-pointer">
            <input
              type="checkbox"
              checked={saveCredential}
              onChange={(e) => setSaveCredential(e.target.checked)}
              className="w-4 h-4 rounded border-[#30363d] bg-[#0d1117] text-[#238636] focus:ring-[#238636]"
            />
            <span className="text-sm text-[#8b949e]">
              Save credential to encrypted vault
            </span>
          </label>

          {/* Actions */}
          <div className="flex items-center gap-3 pt-2">
            <button
              type="button"
              onClick={() => setShowAuthDialog(false)}
              className="flex-1 h-9 text-sm bg-[#21262d] hover:bg-[#30363d] text-[#c9d1d9] rounded-lg transition-colors"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={authType === 'password' ? !password : !privateKey}
              className="flex-1 flex items-center justify-center gap-2 h-9 text-sm bg-[#238636] hover:bg-[#2ea043] disabled:bg-[#1c4f3e] disabled:text-[#484f58] text-white rounded-lg transition-colors"
            >
              <Lock size={14} />
              Authenticate
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
