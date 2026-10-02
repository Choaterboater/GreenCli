// One shared check for URLs the user types (MCP server, Ollama): is this plain
// http:// to another computer? Plain http on this computer is fine; across the
// network anyone on the path can read it.
//
// "This computer" must agree with the Rust check, api::is_loopback_host
// (src-tauri/src/api/mod.rs): localhost, 127.0.0.0/8 and ::1 only. WHATWG URL
// parsing normalises IPv4 shorthand (127.1 -> 127.0.0.1) the same way
// reqwest::Url does, so the two see the same host.

export type UrlKind = 'https' | 'http-local' | 'http-remote' | 'other' | 'invalid';

/** localhost, 127.x.x.x or ::1 (brackets and case don't matter). A NAME that only starts with
 *  127. or localhost (127.0.0.1.nip.io, localhost.evil.example) is another computer. */
export function isLocalHost(hostname: string): boolean {
  const host = hostname.replace(/^\[/, '').replace(/\]$/, '').toLowerCase();
  return host === 'localhost' || host === '::1' || /^127\.\d+\.\d+\.\d+$/.test(host);
}

export function classifyUrl(raw: string): UrlKind {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    return 'invalid';
  }
  if (url.protocol === 'https:') return 'https';
  if (url.protocol === 'http:') return isLocalHost(url.hostname) ? 'http-local' : 'http-remote';
  return 'other';
}

const WARNINGS: Record<'mcp' | 'ollama', string> = {
  mcp:
    'Plain http:// to another computer: anyone on the network can read this traffic, including any token in the headers. Use https:// if the server supports it.',
  ollama:
    'Plain http:// to another computer: your questions and device output cross the network unencrypted. Use https://, or run Ollama on this computer.',
};

/** A warning to show under the URL field, only for plain http:// to another computer. */
export function plainHttpWarning(raw: string, what: 'mcp' | 'ollama'): string | undefined {
  return classifyUrl(raw) === 'http-remote' ? WARNINGS[what] : undefined;
}
