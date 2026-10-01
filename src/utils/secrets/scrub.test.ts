// Ported from casper tests/secrets-scrub.test.ts (all but the file-read test:
// GreenCLI's copy of scrub.ts leaves those rules out).
import { expect, test } from "vitest";
import {
  LINE_MARKER, SECRET_MARKER, containsHiddenSecret, hiddenNote, isSecretKey, looksLikeDeviceConfig, scrubText, scrubValue,
  shouldScrubCommandOutput,
} from "./scrub";

function expectHidden(output: string, secrets: string[]) {
  for (const secret of secrets) expect(output).not.toContain(secret);
}

test("AOS-CX: typed passwords, RADIUS keys and SNMPv3 passwords are hidden", () => {
  const config = [
    "hostname core-cx",
    "user admin group administrators password ciphertext AQBapWq3Zm9vYmFyYmF6cXV4",
    "radius-server host 10.1.1.10 key plaintext RadKeyCX vrf mgmt",
    "snmpv3 user monitor auth sha auth-pass plaintext AuthPw1 priv aes priv-pass plaintext PrivPw1",
    "interface 1/1/1",
    "    no shutdown",
  ].join("\n");
  const result = scrubText(config);
  expectHidden(result.text, ["AQBapWq3Zm9vYmFyYmF6cXV4", "RadKeyCX", "AuthPw1", "PrivPw1"]);
  expect(result.hidden).toBe(4);
  expect(result.text).toContain(`password ciphertext ${SECRET_MARKER}`);
  expect(result.text).toContain(`key plaintext ${SECRET_MARKER} vrf mgmt`);
  expect(result.text).toContain("interface 1/1/1");
});

test("AOS-CX: SNMP community, NTP and OSPF keys, BGP neighbor password", () => {
  const result = scrubText([
    "snmp-server community CxComm",
    "ntp authentication-key 1 md5 ciphertext AQBntpKey==",
    "    ip ospf authentication-key ciphertext AQBospfKey==",
    "    neighbor 10.0.0.2 password ciphertext AQBbgpPw==",
  ].join("\n"));
  expectHidden(result.text, ["CxComm", "AQBntpKey", "AQBospfKey", "AQBbgpPw"]);
  expect(result.hidden).toBe(4);
});

test("AOS 8: PSK, RADIUS key inside an aaa server block and mgmt-user hash are hidden", () => {
  const config = [
    "wlan ssid-profile \"corp\"",
    "   wpa-passphrase SuperPSK123",
    "!",
    "aaa authentication-server radius \"nps1\"",
    "   host 10.1.1.20",
    "   key RadKeyAOS8",
    "!",
    "mgmt-user admin root 2f8e3a1bc0de9a8f7e6d5c4b3a291807",
    "snmp-server user snmpv3 auth-prot sha AuthAos8 priv-prot AES PrivAos8",
  ].join("\n");
  const result = scrubText(config);
  expectHidden(result.text, ["SuperPSK123", "RadKeyAOS8", "2f8e3a1bc0de9a8f7e6d5c4b3a291807", "AuthAos8", "PrivAos8"]);
  expect(result.text).toContain(`   key ${SECRET_MARKER}`);
  expect(result.text).toContain(`mgmt-user admin root ${SECRET_MARKER}`);
  expect(result.hidden).toBe(5);
});

test("AOS 8: a PSK written with a plaintext or ciphertext word is hidden too", () => {
  const result = scrubText("wpa-passphrase plaintext Sup3rS3cret\nwpa-hexkey ciphertext 0a1b2c3d");
  expectHidden(result.text, ["Sup3rS3cret", "0a1b2c3d"]);
  expect(result.text).toContain(`wpa-passphrase plaintext ${SECRET_MARKER}`);
  expect(result.hidden).toBe(2);
});

test("AOS 8: a key line outside an aaa server block is left alone", () => {
  const text = [
    "aaa authentication-server radius \"nps1\"",
    "   key RadKeyAOS8",
    "!",
    "ids general-profile \"default\"",
    "   key KeepMeVisible",
    "crypto-local pki key-name",
  ].join("\n");
  const result = scrubText(text);
  expect(result.text).toContain("   key KeepMeVisible");
  expect(result.text).not.toContain("RadKeyAOS8");
  expect(result.hidden).toBe(1);
});

test("AOS-S: manager password, RADIUS key and SNMP community are hidden", () => {
  const result = scrubText([
    "password manager user-name admin sha1 \"8c6976e5b5410415bde908bd4dee15dfb167a9c8\"",
    "radius-server host 10.1.1.30 key \"RadKeyAOSS\"",
    "snmp-server community \"AossComm\" operator",
  ].join("\n"));
  expectHidden(result.text, ["8c6976e5b5410415bde908bd4dee15dfb167a9c8", "RadKeyAOSS", "AossComm"]);
  expect(result.text).toContain(`key "${SECRET_MARKER}"`);
  expect(result.hidden).toBe(3);
});

test("Junos set style: encrypted-password, $9$ secrets and SNMP community names are hidden", () => {
  const config = [
    "## Last commit: 2026-09-01 10:00:00 UTC by admin",
    "version 23.4R1.9;",
    "set system root-authentication encrypted-password \"$6$abc$Q0x1c2V0aGlzaGFzaA\"",
    "set system radius-server 10.1.1.40 secret \"$9$Hk5FCtu0IcSeK\"",
    "set snmp community JunosComm authorization read-only",
    "set protocols ospf area 0 interface ge-0/0/0 authentication md5 1 key \"$9$abcdEFgh\"",
    "set security ike policy p1 pre-shared-key ascii-text \"$9$pskpskpsk\"",
  ].join("\n");
  const result = scrubText(config);
  expectHidden(result.text, ["$6$abc", "$9$Hk5", "JunosComm", "$9$abcd", "$9$psk"]);
  expect(result.text).toContain(`set system root-authentication encrypted-password "${SECRET_MARKER}"`);
  expect(result.text).toContain(`set snmp community ${SECRET_MARKER} authorization read-only`);
  expect(result.hidden).toBe(5);
  expect(looksLikeDeviceConfig(config)).toBe(true);
});

test("Junos curly style: passwords and the community name inside snmp { } are hidden", () => {
  const config = [
    "system {",
    "    root-authentication {",
    "        encrypted-password \"$6$xyz$CurlyHash\"; ## SECRET-DATA",
    "    }",
    "}",
    "snmp {",
    "    community JunosComm {",
    "        authorization read-only;",
    "    }",
    "}",
    "protocols {",
    "    community NotSnmp;",
    "}",
  ].join("\n");
  const result = scrubText(config);
  expectHidden(result.text, ["$6$xyz", "JunosComm"]);
  expect(result.text).toContain(`encrypted-password "${SECRET_MARKER}"; ## SECRET-DATA`);
  expect(result.text).toContain(`    community ${SECRET_MARKER} {`);
  expect(result.text).toContain("community NotSnmp;"); // outside the snmp block
  expect(result.hidden).toBe(2);
});

test("a bare $9$ token in show output is hidden", () => {
  const result = scrubText("Neighbor 10.0.0.1  auth-key $9$ZUDk.mT3/tpWLxdVs  state Full");
  expect(result.text).not.toContain("$9$ZUDk");
  expect(result.hidden).toBe(1);
});

test("Cisco: enable secret, username password 7 and SNMP community are hidden; safe lines stay", () => {
  const config = [
    "hostname edge-r1",
    "enable secret 5 $1$mERr$hx5rVt7rPNoS4wqbXKX7m0",
    "username netops privilege 15 password 7 0822455D0A16",
    "snmp-server community CiscoComm RO",
    "aaa authentication login default group radius",
    "ip ssh pubkey-chain",
    " username netops",
    "  key-hash ssh-rsa AAAAB3NzaC1yc2EAAAADAQABAAABAQC7 netops@laptop",
    "tacacs-server host 10.1.1.50 key 7 045802150C2E",
    " standby 1 authentication HsrpKey",
    "interface GigabitEthernet0/1",
    " ip ospf message-digest-key 1 md5 7 13061E010803",
    "snmp-server user mon grp v3 auth sha AuthCisco priv aes 128 PrivCisco",
  ].join("\n");
  const result = scrubText(config);
  expectHidden(result.text, ["$1$mERr", "0822455D0A16", "CiscoComm", "045802150C2E", "HsrpKey", "13061E010803", "AuthCisco", "PrivCisco"]);
  expect(result.text).toContain("aaa authentication login default group radius");
  expect(result.text).toContain("key-hash ssh-rsa AAAAB3NzaC1yc2EAAAADAQABAAABAQC7 netops@laptop");
  expect(result.text).toContain(`snmp-server community ${SECRET_MARKER} RO`);
  expect(result.hidden).toBe(8);
});

test("PEM private keys are hidden but certificates stay", () => {
  const text = [
    "-----BEGIN CERTIFICATE-----",
    "MIIBCertBody",
    "-----END CERTIFICATE-----",
    "-----BEGIN RSA PRIVATE KEY-----",
    "MIIEpAIBAAKCAQEAsecret1",
    "MIIEpAIBAAKCAQEAsecret2",
    "-----END RSA PRIVATE KEY-----",
  ].join("\n");
  const result = scrubText(text);
  expect(result.text).toContain("MIIBCertBody");
  expectHidden(result.text, ["secret1", "secret2"]);
  expect(result.hidden).toBe(1);
  expect(result.kinds).toEqual(["private-key"]);
});

test("a server's reversible tokens, ****** and markers pass through and are not counted", () => {
  const token = `hpe_mcp_secret_${"0123456789abcdef".repeat(2)}`;
  const text = [
    `wpa-passphrase ${token}`,
    "snmp-server community ******",
    `set system root-authentication encrypted-password "${SECRET_MARKER}"`,
  ].join("\n");
  const result = scrubText(text);
  expect(result.text).toBe(text);
  expect(result.hidden).toBe(0);
  expect(scrubText(scrubText("snmp-server community X1 RO").text).hidden).toBe(0);
});

test("plain prose about passwords is not treated as a secret", () => {
  const text = "The password is stored on the switch. Set the secret for the RADIUS server first.";
  expect(scrubText(text).text).toBe(text);
});

test("scrubValue hides config text and secret keys inside JSON text blocks, and keeps paging fields", () => {
  const payload = {
    config: "hostname ap1\nwlan ssid-profile corp\n   wpa-passphrase SuperPSK123\n",
    psk: "abc",
    next_cursor: "c1",
    list_key: "items",
    _pagination: { list_key: "items", key: "k" },
    public_key: "ssh-ed25519 AAAAC3Nza",
  };
  const raw = { content: [{ type: "text", text: JSON.stringify(payload) }], isError: false };
  const result = scrubValue(raw);
  const text = (result.value.content[0] as { text: string }).text;
  const parsed = JSON.parse(text);
  expect(parsed.config).not.toContain("SuperPSK123");
  expect(parsed.config).toContain(`wpa-passphrase ${SECRET_MARKER}`);
  expect(parsed.psk).toBe(SECRET_MARKER);
  expect(parsed.next_cursor).toBe("c1");
  expect(parsed.list_key).toBe("items");
  expect(parsed._pagination).toEqual({ list_key: "items", key: "k" });
  expect(parsed.public_key).toBe("ssh-ed25519 AAAAC3Nza");
  expect(result.hidden).toBe(2);
  expect(raw.content[0]!.text).toBe(JSON.stringify(payload)); // input is not changed
});

test("scrubValue leaves results without secrets as the same object", () => {
  const raw = { content: [{ type: "text", text: "{\"ok\":true}" }] };
  const result = scrubValue(raw);
  expect(result.value).toBe(raw);
  expect(result.hidden).toBe(0);
});

test("secret key names", () => {
  for (const name of ["password", "adminPassword", "radius_secret", "communityString", "wpa-passphrase", "client_secret", "api_key"]) {
    expect(isSecretKey(name)).toBe(true);
  }
  for (const name of ["next_cursor", "cursor", "list_key", "key", "public_key", "password_policy", "ssid"]) expect(isSecretKey(name)).toBe(false);
});

test("device keys and tokens under their own names are hidden from the AI; paging tokens are kept", () => {
  for (const name of ["pre_shared_key", "preSharedKey", "psk_key", "shared_key", "tacacs_key", "radius_key", "wep_key", "wpa_key",
    "md5_key", "authentication_key", "secret_key", "encryption_key", "token", "api_token", "auth_token", "bearerToken",
    "session_token", "enable_secret", "snmp_community"]) {
    expect([name, isSecretKey(name)]).toEqual([name, true]);
  }
  for (const name of ["next_token", "nextPageToken", "page_token", "continuation_token", "token_type", "token_expiry", "key_id",
    "ssh_public_key", "list_key"]) {
    expect([name, isSecretKey(name)]).toEqual([name, false]);
  }
  const result = scrubValue({ content: [{ type: "text", text: JSON.stringify({
    wlan: { ssid: "corp", pre_shared_key: "Corp-PSK-2024!" }, tacacs: [{ host: "10.0.0.5", tacacs_key: "Tk-key-9" }],
    api_token: "abcd1234efgh5678", next_token: "page-2",
  }) }] });
  const text = (result.value as { content: { text: string }[] }).content[0]!.text;
  expect(text).not.toContain("Corp-PSK-2024!");
  expect(text).not.toContain("Tk-key-9");
  expect(text).not.toContain("abcd1234efgh5678");
  expect(text).toContain("page-2");
  expect(result.hidden).toBe(3);
});

test("AOS-CX REST names: RADIUS/TACACS passkey, SNMPv3 pass phrases, UBT and OSPF keys", () => {
  for (const name of ["passkey", "auth_pass_phrase", "priv_pass_phrase", "snmp_communities", "papi_security_key", "ospf_auth_md5_keys"]) {
    expect([name, isSecretKey(name)]).toEqual([name, true]);
  }
  for (const name of ["admin_password_set", "auth_protocol", "priv_protocol", "send_community_type", "public_keys"]) {
    expect([name, isSecretKey(name)]).toEqual([name, false]);
  }
  const result = scrubValue({
    radius: { address: "10.1.1.10", passkey: "AQBapRadius==", port: 1812 },
    snmpv3_user: { user_name: "monitor", auth_protocol: "sha", auth_pass_phrase: "AQBauth==", priv_pass_phrase: "AQBpriv==" },
    ubt_zone: { papi_security_key: "AQBpapi==" },
  });
  const text = JSON.stringify(result.value);
  expectHidden(text, ["AQBapRadius", "AQBauth", "AQBpriv", "AQBpapi"]);
  expect(text).toContain("\"auth_protocol\":\"sha\"");
  expect(result.hidden).toBe(4);
  expect(result.kinds).toEqual(["password", "key"]);
});

test("a list or map of strings under a secret name is hidden entry by entry", () => {
  const raw = {
    snmp_communities: ["public-ro", "Priv@te-rw", "******", null],
    ospf_auth_md5_keys: { "1": "AQBmd5one==", "2": "AQBmd5two==" },
    api_keys: [{ name: "ci", id: 7 }],
    md5_keys: [1, 2],
  };
  const result = scrubValue(raw);
  expect(result.value.snmp_communities).toEqual([SECRET_MARKER, SECRET_MARKER, "******", null]);
  expect(result.value.ospf_auth_md5_keys).toEqual({ "1": SECRET_MARKER, "2": SECRET_MARKER });
  expect(result.value.api_keys).toEqual([{ name: "ci", id: 7 }]);
  expect(result.value.md5_keys).toEqual([1, 2]);
  expect(result.hidden).toBe(4);
  expect(result.kinds).toEqual(["key", "community"]);
  expect(raw.snmp_communities[0]).toBe("public-ro"); // input is not changed
});

test("containsHiddenSecret finds a marker anywhere in tool arguments", () => {
  expect(containsHiddenSecret({ commands: ["set snmp community x", `set system root-authentication encrypted-password "${SECRET_MARKER}"`] })).toBe(true);
  expect(containsHiddenSecret({ line: LINE_MARKER })).toBe(true);
  expect(containsHiddenSecret({ commands: ["show version"], n: 3 })).toBe(false);
});

test("hiddenNote uses plain words", () => {
  expect(hiddenNote(3, ["password", "key", "community"])).toBe("3 secrets hidden before the AI saw this (passwords, keys, SNMP communities).");
  expect(hiddenNote(1, ["psk"])).toBe("1 secret hidden before the AI saw this (Wi-Fi and VPN keys).");
  expect(hiddenNote(0, [])).toBe("");
});

test("config detection needs two anchor lines or one strict secret line", () => {
  expect(looksLikeDeviceConfig("hostname sw1\ninterface 1/1/1\n")).toBe(true);
  expect(looksLikeDeviceConfig("hostname sw1\n")).toBe(false);
  expect(looksLikeDeviceConfig("snmp-server community X RO\n")).toBe(true);
  expect(looksLikeDeviceConfig("const password = input.value;\nexport default password;\n")).toBe(false);
  expect(shouldScrubCommandOutput("src/a.ts:1: hello\n")).toBe(false);
});
