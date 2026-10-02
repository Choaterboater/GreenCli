// "Yes, until GreenCLI closes" answers in the MCP approval box. In memory only:
// they end when GreenCLI closes. Each one is tied to the tool's fingerprint
// (mcpGate.ts toolFingerprint), so a tool the server redefines asks again.
import { create } from 'zustand';

export function allowanceKey(server: string, tool: string): string {
  return `${server}\u0000${tool}`;
}

interface McpApprovalState {
  /** key -> toolFingerprint at the time of "Yes, until GreenCLI closes" */
  allowed: Record<string, string>;
  allow(server: string, tool: string, fingerprint: string): void;
  /** True only when the stored fingerprint matches. */
  isAllowed(server: string, tool: string, fingerprint: string): boolean;
  clearServer(server: string): void;
  clearAll(): void;
}

export const useMcpApprovalStore = create<McpApprovalState>()((set, get) => ({
  allowed: {},
  allow: (server, tool, fingerprint) =>
    set((s) => ({ allowed: { ...s.allowed, [allowanceKey(server, tool)]: fingerprint } })),
  isAllowed: (server, tool, fingerprint) => {
    const key = allowanceKey(server, tool);
    return Object.hasOwn(get().allowed, key) && get().allowed[key] === fingerprint;
  },
  clearServer: (server) =>
    set((s) => {
      const prefix = allowanceKey(server, '');
      return {
        allowed: Object.fromEntries(Object.entries(s.allowed).filter(([key]) => !key.startsWith(prefix))),
      };
    }),
  clearAll: () => set({ allowed: {} }),
}));
