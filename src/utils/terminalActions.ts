export interface TerminalActionAdapter {
  paste: (text: string) => void;
  copySelection: () => string;
  focus: () => void;
  clear: () => void;
}

const registry = new Map<string, TerminalActionAdapter>();

export function registerTerminalActionAdapter(sessionId: string, adapter: TerminalActionAdapter): void {
  registry.set(sessionId, adapter);
}

export function unregisterTerminalActionAdapter(sessionId: string): void {
  registry.delete(sessionId);
}

export function getTerminalActionAdapter(sessionId: string): TerminalActionAdapter | undefined {
  return registry.get(sessionId);
}
