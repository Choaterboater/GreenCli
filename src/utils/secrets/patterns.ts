// Copied from casper src/secrets/patterns.ts @ 073055e. Do not edit here: change Casper, re-copy.
// ---- casper source below ----
/**
 * Line rules for secrets in network device configuration (Aruba AOS-CX,
 * AOS 8 / Instant, AOS-S, Junos set and curly, Cisco IOS / NX-OS / ASA).
 *
 * Each rule captures only the secret value; the words around it stay, so the
 * AI still sees what kind of line it is. The rules hide known formats only:
 * unknown formats can still leak, so callers must never promise "all secrets".
 * Everything here may only ever hide more, never less.
 */

export type SecretKind = "password" | "hash" | "key" | "psk" | "community" | "private-key";
export type SecretPlatform = "aos-cx" | "aos8" | "aos-s" | "junos" | "cisco" | "generic";
/** Rules that only apply inside a block tracked by the scrubber. */
export type SecretBlock = "auth-server" | "junos-snmp";

export interface SecretRule {
  id: string;
  platform: SecretPlatform;
  kind: SecretKind;
  /** Global regex with the `d` flag. Each group listed in `groups` is one secret value. */
  re: RegExp;
  groups: number[];
  /** Specific enough that a single hit means "this is device config". */
  strict: boolean;
  block?: SecretBlock;
}

/** A value: a quoted string (only the inside is replaced) or one bare word. */
const QUOTED = String.raw`"[^"\n]*"|'[^'\n]*'`;
const BARE = String.raw`[^\s;"'{}\[\]]+`;
/** Words that follow the key word but are part of the syntax, never the secret. */
const SYNTAX = String.raw`plaintext|ciphertext|encrypted|hidden|unencrypted|auth-pass|priv-pass|auth-prot|priv-prot`;
/** For the broad "password X" / "secret X" rules only: syntax and prose words. */
const GENERIC_SKIP = String.raw`${SYNTAX}|manager|operator|port-access|prompt|policy|minimum|complexity|history|expiration|lockout|attempts|required|none|all|enable|disable|is|are|was|be|must|the|a|an|and|or|for|to|of|in|on|with|from|that|this|which|will|can|should|may|used|set|not|if|you|your|field|value|string|type|length|change|reset|recovery|file|key|keys`;

const value = (skip = SYNTAX) => String.raw`((?!(?:${skip})(?:\s|$|;))(?:${QUOTED}|${BARE}))`;
const V = value();
const VG = value(GENERIC_SKIP);

function rule(id: string, platform: SecretPlatform, kind: SecretKind, source: string,
  options: { groups?: number[]; strict?: boolean; block?: SecretBlock; flags?: string } = {}): SecretRule {
  return { id, platform, kind, re: new RegExp(source, `dg${options.flags ?? "i"}`), groups: options.groups ?? [1],
    strict: options.strict ?? false, block: options.block };
}

export const SECRET_RULES: readonly SecretRule[] = [
  // AOS-CX: every stored secret carries a plaintext/ciphertext word before it.
  rule("aoscx-typed-secret", "aos-cx", "password",
    String.raw`\b(?:password|key|auth-pass|priv-pass|authentication-key|md5|sha1|sha256|sha512|message-digest-key\s+\d+\s+md5)\s+(?:plaintext|ciphertext)\s+${V}`,
    { strict: true }),
  // AOS 8 / Instant
  rule("aos8-wpa-passphrase", "aos8", "psk", String.raw`\bwpa-passphrase\s+(?:(?:plaintext|ciphertext)\s+)?${V}`, { strict: true }),
  rule("aos8-wpa-hexkey", "aos8", "psk", String.raw`\bwpa-hexkey\s+(?:(?:plaintext|ciphertext)\s+)?${V}`, { strict: true }),
  rule("aos8-auth-server-key", "aos8", "key", String.raw`^\s+key\s+(?:[0-9]\s+)?${V}`, { block: "auth-server" }),
  rule("aos8-mgmt-user", "aos8", "hash",
    String.raw`^\s*mgmt-user\s+(?!ssh-pubkey\b|localauth-disable\b|webui-cacert\b)\S+\s+\S+\s+${V}`, { strict: true }),
  rule("aos8-ipsec", "aos8", "psk", String.raw`\b(?:masterip|localip)\b.*?\sipsec\s+${V}`, { strict: true }),
  rule("aos8-snmpv3-auth", "aos8", "password", String.raw`\bauth-prot\s+\S+\s+${V}`, { strict: true }),
  rule("aos8-snmpv3-priv", "aos8", "password", String.raw`\bpriv-prot\s+\S+\s+${V}`, { strict: true }),
  // AOS-S
  rule("aoss-password", "aos-s", "password",
    String.raw`\bpassword\s+(?:manager|operator|port-access)\s+(?:user-name\s+\S+\s+)?(?:plaintext|sha1|sha-256)\s+${V}`, { strict: true }),
  // Shared by AOS-S, AOS 8, Cisco: server keys on one line.
  rule("server-key", "generic", "key",
    String.raw`\b(?:radius|tacacs)-server\b.*?\skey\s+(?:[0-9]\s+)?${V}`, { strict: true }),
  rule("snmp-server-community", "generic", "community", String.raw`\bsnmp-server\s+community\s+${V}`, { strict: true }),
  rule("crypto-isakmp-key", "generic", "psk", String.raw`\bcrypto\s+isakmp\s+key\s+(?:[0-9]\s+)?${V}`, { strict: true }),
  // Junos (set and curly)
  rule("junos-password-words", "junos", "password",
    String.raw`\b(?:encrypted-password|simple-password|authentication-password|privacy-password|plain-text-password-value)\s+${V}`,
    { strict: true }),
  rule("junos-authentication-key", "junos", "key",
    String.raw`\bauthentication-key\s+(?!\d+\s+(?:md5|sha))(?:[0-9]\s+)?${V}`),
  rule("pre-shared-key", "generic", "psk",
    String.raw`\bpre-shared-key\s+(?!address\b)(?:(?:ascii-text|hexadecimal|local|remote|[0-9])\s+)?${V}`, { strict: true }),
  rule("pre-shared-key-address", "cisco", "psk", String.raw`\bpre-shared-key\s+address\s+\S+(?:\s+\S+)?\s+key\s+${V}`, { strict: true }),
  rule("junos-md5-key", "junos", "key", String.raw`\bmd5\s+\d+\s+key\s+${V}`, { strict: true }),
  rule("junos-snmp-community", "junos", "community", String.raw`\bsnmp\s+community\s+${V}`, { strict: true }),
  rule("junos-snmp-block-community", "junos", "community", String.raw`^\s*community\s+${V}`, { block: "junos-snmp" }),
  rule("junos-dollar9", "junos", "password", String.raw`(\$9\$[^\s";'{}]+)`, { strict: true, flags: "" }),
  // Cisco IOS / NX-OS / ASA
  rule("cisco-enable", "cisco", "password",
    String.raw`\benable\s+(?:secret|password)\s+(?:level\s+\d+\s+)?(?:[0-9]\s+)?${V}`, { strict: true }),
  rule("cisco-username", "cisco", "password",
    String.raw`^\s*username\s+\S+\b.*?\s(?:secret|password)\s+(?:[0-9]\s+)?${V}`, { strict: true }),
  rule("cisco-snmp-auth", "cisco", "password", String.raw`\bauth\s+(?:md5|sha\S*)\s+${V}`),
  rule("cisco-snmp-priv", "cisco", "password",
    String.raw`\bpriv\s+(?:(?:des|3des|des56|aes-?\d*)(?:\s+\d+)?\s+)?(?!(?:des|3des|des56|aes-?\d*)\s)${V}`),
  rule("cisco-key-string", "cisco", "key", String.raw`\bkey-string\s+(?:[0-9]\s+)?${V}`, { strict: true }),
  rule("cisco-message-digest", "cisco", "key", String.raw`\bmessage-digest-key\s+\d+\s+md5\s+(?:[0-9]\s+)?${V}`, { strict: true }),
  rule("cisco-ntp-key", "cisco", "key", String.raw`\bntp\s+authentication-key\s+\d+\s+(?:md5|sha\d*|cmac-aes-128)\s+${V}`, { strict: true }),
  rule("cisco-wpa-psk", "cisco", "psk", String.raw`\bwpa-psk\s+(?:ascii|hex)\s+(?:[0-9]\s+)?${V}`, { strict: true }),
  rule("cisco-standby", "cisco", "key",
    String.raw`\bstandby\s+(?:\d+\s+)?authentication\s+(?!md5\b)(?:text\s+)?${V}`, { strict: true }),
  rule("asa-passwd", "cisco", "password", String.raw`^\s*passwd\s+${V}`, { strict: true }),
  // Generic
  rule("generic-password", "generic", "password", String.raw`(?:^|[\s{])(?:password|secret|passwd)\s+(?:(?:[0-9]|level\s+\d+)\s+)?${VG}`),
  rule("generic-hash", "generic", "hash",
    String.raw`\b(?:password|secret|hash|passwd)\b[^\n]*?(\$(?:1|5|6|8|y|2[aby]?)\$[^\s";'{}]+)`),
];

/** Values that must pass through unchanged and are never counted. */
export function keepLiterally(value: string): boolean {
  return !value
    || /^\*{3,}$/.test(value)
    // hpe-networking-mcp tokenises secrets itself and swaps these back on later calls.
    || /^hpe_mcp_secret_[0-9a-f]{32}$/i.test(value)
    || value.startsWith("<secret hidden>") || value.startsWith("<secret")
    || value.startsWith("<line hidden");
}

/** Starts a block whose indented "key X" lines are RADIUS/TACACS keys. */
export const AUTH_SERVER_BLOCK = /^(\s*)(?:aaa\s+authentication-server\s+(?:radius|tacacs)\b|wlan\s+auth-server\b|radius\s+server\b|tacacs\s+server\b)/i;
/** Starts a Junos curly "snmp {" block, where "community NAME" names are secrets. */
export const JUNOS_SNMP_BLOCK = /^\s*snmp\s*\{/;
export const PEM_BEGIN = /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----/;
export const PEM_END = /-----END [A-Z0-9 ]*PRIVATE KEY-----/;

/** Anchor lines for "this text is a device config". Two are needed. */
export const CONFIG_ANCHORS: readonly RegExp[] = [
  /^hostname\s+\S+/m,
  /^\s*version\s+[\w.\-]+;/m,
  /^## Last commit/m,
  /^Current configuration/m,
  /^Running configuration/m,
  /^\s*set\s+(?:system|interfaces|protocols|snmp|security|policy-options|routing-options|vlans)\b/m,
  /^interface\s+\d+\/\d+\/\d+/m,
  /^interface\s+(?:GigabitEthernet|TenGigabitEthernet|Ethernet|Vlan|vlan|gigabitethernet|port-channel|mgmt)\S*/m,
  /^wlan\s+ssid-profile\b/m,
  /^\s*system\s*\{/m,
  /^\s*interfaces\s*\{/m,
  /^aaa\s+(?:authentication|new-model|profile)\b/m,
];

export const KIND_WORDS: Record<SecretKind, string> = {
  password: "passwords",
  hash: "password hashes",
  key: "keys",
  psk: "Wi-Fi and VPN keys",
  community: "SNMP communities",
  "private-key": "private keys",
};
export const KIND_ORDER: readonly SecretKind[] = ["password", "hash", "key", "psk", "community", "private-key"];
