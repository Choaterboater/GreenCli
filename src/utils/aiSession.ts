// Which session the AI's tools act on. Only DEVICE sessions (SSH, Telnet,
// Serial) are ever picked. A local tab is a shell on this computer, or a
// Claude/Kimi/Copilot CLI running in one: the AI's "read" allowlist (cat,
// echo, …) would run there with no prompt, and text injected through device
// output could steer the AI into typing into another AI agent. So with no
// device to use, the AI gets no session and its terminal tool says so.

import type { Session } from '../types';

export function pickAiSession(sessions: Session[], activeSessionId: string | null | undefined): Session | undefined {
  const active = sessions.find((s) => s.sessionId === activeSessionId);
  if (active && active.config.protocol !== 'local') {
    // The active tab is a DEVICE: always target it, even while it is
    // connecting/reconnecting/down. Falling back to "any connected session"
    // here ran the AI's commands on a different device than the one on
    // screen whenever the active tab blipped.
    return active;
  }
  // The active tab is a local shell (or nothing is open): use a connected device.
  return sessions.find((s) => s.config.protocol !== 'local' && s.connected);
}
