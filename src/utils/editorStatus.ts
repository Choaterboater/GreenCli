// What the Config Editor's status line says about where Send goes, and the
// vendor check that catches a Junos tab about to go to an Aruba switch.
// Pure (the clock is passed in) so it is unit-tested; ConfigEditor renders it.

/** Device CLIs that read the same config. Mist-managed switches run Junos. */
const FAMILY: Record<string, string> = {
  'aruba-cx': 'aruba-cx',
  'aruba-aos-s': 'aruba-aos-s',
  'aruba-ap': 'aruba-ap',
  'aruba-controller': 'aruba-controller',
  'juniper-junos': 'junos',
  mist: 'junos',
};

const NAME: Record<string, string> = {
  'aruba-cx': 'Aruba CX',
  'aruba-aos-s': 'Aruba AOS-S',
  'aruba-ap': 'Aruba AP',
  'aruba-controller': 'Aruba controller',
  'juniper-junos': 'Junos',
  mist: 'Junos (Mist)',
};

/** The short device name for a device type or editor language ("Aruba CX"), if it is a device. */
export function deviceName(id: string): string | undefined {
  return NAME[id];
}

/**
 * Why this tab's text doesn't fit the device Send goes to. Undefined when it
 * fits, or when either side isn't a known device CLI (plain text, a generic
 * device, a code file): there is nothing to compare then.
 */
export function vendorMismatch(editorLanguage: string, deviceType: string, target: string): string | undefined {
  const tab = FAMILY[editorLanguage];
  const device = FAMILY[deviceType];
  if (!tab || !device || tab === device) return undefined;
  return `This tab is ${NAME[editorLanguage]}, but ${target} is ${NAME[deviceType]}.`;
}

export interface SendTargetInput {
  /** The terminal tab Send goes to, or null when none is open. */
  session: {
    name: string;
    connected: boolean;
    configMode: boolean;
    deviceType: string;
  } | null;
  /** The running-config pulled from that device, if any. */
  pulled?: { at: number; truncated: boolean };
  editorLanguage: string;
  now: number;
}

export interface SendTargetStatus {
  /** "Send to: core-sw1", or why there is nowhere to send. */
  target: string;
  /** "Aruba CX"; absent for a generic device. */
  device?: string;
  configMode: boolean;
  /** "pulled 12 min ago", "not pulled yet"; absent with no session. */
  pulled?: string;
  mismatch?: string;
  tone: 'normal' | 'muted' | 'danger';
}

/** "just now", "12 min ago", "3 h ago", "2 days ago". */
export function ago(then: number, now: number): string {
  const minutes = Math.floor(Math.max(0, now - then) / 60_000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} h ago`;
  const days = Math.floor(hours / 24);
  return `${days} ${days === 1 ? 'day' : 'days'} ago`;
}

export function sendTargetStatus({ session, pulled, editorLanguage, now }: SendTargetInput): SendTargetStatus {
  if (!session) {
    return { target: 'No session: open a device tab to send', configMode: false, tone: 'muted' };
  }
  const mismatch = vendorMismatch(editorLanguage, session.deviceType, session.name);
  return {
    target: `Send to: ${session.name}${session.connected ? '' : ' (disconnected)'}`,
    device: deviceName(session.deviceType),
    configMode: session.connected && session.configMode,
    pulled: pulled
      ? `pulled ${ago(pulled.at, now)}${pulled.truncated ? ', may be cut off' : ''}`
      : 'not pulled yet',
    mismatch,
    tone: mismatch ? 'danger' : session.connected ? 'normal' : 'muted',
  };
}
