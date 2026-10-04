// "Yes, until GreenCLI closes" answers in the MCP approval box. In memory only:
// they end when GreenCLI closes. Each one is tied to the tool's fingerprint
// (mcpGate.ts toolFingerprint), so a tool the server redefines asks again.
//
// Live show commands (utils/mcpLive.ts) keep their own answers per device:
// "Yes, show commands on <device> until GreenCLI closes" (server + tool + device).
import { create } from 'zustand';

export function allowanceKey(server: string, tool: string): string {
  return `${server}\u0000${tool}`;
}

function deviceKey(server: string, tool: string, device: string): string {
  return `${allowanceKey(server, tool)}\u0000${device}`;
}

const dropServer = (map: Record<string, true | string>, server: string) => {
  const prefix = allowanceKey(server, '');
  return Object.fromEntries(Object.entries(map).filter(([key]) => !key.startsWith(prefix)));
};

interface McpApprovalState {
  /** key -> toolFingerprint at the time of "Yes, until GreenCLI closes" */
  allowed: Record<string, string>;
  /** server + tool + device keys answered "Yes, … on this device until GreenCLI closes" */
  devices: Record<string, true>;
  allow(server: string, tool: string, fingerprint: string): void;
  /** True only when the stored fingerprint matches. */
  isAllowed(server: string, tool: string, fingerprint: string): boolean;
  allowDevice(server: string, tool: string, device: string): void;
  isDeviceAllowed(server: string, tool: string, device: string): boolean;
  clearServer(server: string): void;
  clearAll(): void;
}

export const useMcpApprovalStore = create<McpApprovalState>()((set, get) => ({
  allowed: {},
  devices: {},
  allow: (server, tool, fingerprint) =>
    set((s) => ({ allowed: { ...s.allowed, [allowanceKey(server, tool)]: fingerprint } })),
  isAllowed: (server, tool, fingerprint) => {
    const key = allowanceKey(server, tool);
    return Object.hasOwn(get().allowed, key) && get().allowed[key] === fingerprint;
  },
  allowDevice: (server, tool, device) =>
    set((s) => ({ devices: { ...s.devices, [deviceKey(server, tool, device)]: true } })),
  isDeviceAllowed: (server, tool, device) => {
    const key = deviceKey(server, tool, device);
    return Object.hasOwn(get().devices, key) && get().devices[key] === true;
  },
  clearServer: (server) =>
    set((s) => ({
      allowed: dropServer(s.allowed, server) as Record<string, string>,
      devices: dropServer(s.devices, server) as Record<string, true>,
    })),
  clearAll: () => set({ allowed: {}, devices: {} }),
}));
