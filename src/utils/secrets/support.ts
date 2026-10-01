// The secret rules use regex lookbehind and the `d` (match indices) flag.
// WebView2 and macOS 13.3+ WebKit have both; an older WebKit (an old Linux
// WebKitGTK) throws on them. Checked once, without loading the rules.

let supported: boolean | undefined;

/** True when this WebView can run the secret filter. */
export function secretFilterSupported(): boolean {
  if (supported === undefined) {
    try {
      supported = new RegExp('(?<!a)b(c)', 'dg').exec('xbc')?.indices?.[1]?.[0] === 2;
    } catch {
      supported = false;
    }
  }
  return supported;
}
