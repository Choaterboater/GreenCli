#!/usr/bin/env node
// Checks Tauri update signatures with Node's own crypto, so release.yml can
// check them on every runner (macOS and Windows have no minisign).
//
// Tauri's .sig and .pub files are base64 of minisign text. A signature is
// Ed25519 over the BLAKE2b-512 hash of the file ("ED"), plus a second
// signature over the first one and the trusted comment.
//
//   node scripts/update-signature.mjs verify-dir <dir> <key.pub>
//       Every *.sig under <dir> must match its file and the key. Fails when
//       there is no .sig at all.
//   node scripts/update-signature.mjs release-files <latest.json> <assets.json> <owner/repo> <tag>
//       Prints the release file names latest.json points to, one per line.
//       <assets.json> is the release's asset list from the GitHub API.
//   node scripts/update-signature.mjs check-release <dir> <assets.json> <owner/repo> <tag> <platform>...
//       <dir> holds latest.json, the files it points to and the
//       update-key-<os>-<arch>.pub files. Every listed platform must be in
//       latest.json, every entry's url must be a file of this release, and
//       every entry's signature must match its file, its platform's key and
//       the release version.

import { createHash, createPublicKey, verify } from 'node:crypto';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { basename, join } from 'node:path';
import { fileURLToPath } from 'node:url';

function fromBase64Text(text, what) {
  const t = String(text).trim();
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(t)) throw new Error(`${what} is not base64`);
  return Buffer.from(t, 'base64').toString('utf8');
}

function lines(text) {
  return text.split(/\r?\n/).filter((l) => l.length > 0);
}

/** A Tauri .pub file's text → { keyId, key }. */
export function parsePublicKey(pubText) {
  const text = fromBase64Text(pubText, 'The public key');
  const keyLine = lines(text).find((l) => !l.startsWith('untrusted comment:'));
  const raw = Buffer.from(keyLine ?? '', 'base64');
  if (raw.length !== 42 || raw.subarray(0, 2).toString() !== 'Ed') {
    throw new Error('The public key is not a minisign Ed25519 key');
  }
  const key = createPublicKey({
    key: { kty: 'OKP', crv: 'Ed25519', x: raw.subarray(10).toString('base64url') },
    format: 'jwk',
  });
  return { keyId: raw.subarray(2, 10), key };
}

/** A Tauri .sig file's text → its parts. */
export function parseSignature(sigText) {
  const text = fromBase64Text(sigText, 'The signature');
  const [untrusted, sigLine, trustedLine, globalLine] = lines(text);
  if (!untrusted?.startsWith('untrusted comment:') || !trustedLine?.startsWith('trusted comment: ')) {
    throw new Error('The signature is not a minisign signature');
  }
  const raw = Buffer.from(sigLine ?? '', 'base64');
  const global = Buffer.from(globalLine ?? '', 'base64');
  const alg = raw.subarray(0, 2).toString();
  if (raw.length !== 74 || (alg !== 'ED' && alg !== 'Ed') || global.length !== 64) {
    throw new Error('The signature is not a minisign Ed25519 signature');
  }
  return {
    prehashed: alg === 'ED',
    keyId: raw.subarray(2, 10),
    signature: raw.subarray(10),
    trusted: trustedLine.slice('trusted comment: '.length),
    global,
  };
}

/** Throws unless `sigText` signs `data` with the key in `pubText`. */
export function verifyUpdateSignature(data, sigText, pubText) {
  const pub = parsePublicKey(pubText);
  const sig = parseSignature(sigText);
  if (!pub.keyId.equals(sig.keyId)) throw new Error('The signature was made with a different key');
  const message = sig.prehashed ? createHash('blake2b512').update(data).digest() : data;
  if (!verify(null, message, pub.key, sig.signature)) throw new Error('The signature does not match the file');
  const signedComment = Buffer.concat([sig.signature, Buffer.from(sig.trusted, 'utf8')]);
  if (!verify(null, signedComment, pub.key, sig.global)) throw new Error('The trusted comment was changed');
  return sig.trusted;
}

/** `darwin-aarch64-app` → `darwin-aarch64` (the key file's platform). */
export function keyPlatform(entry) {
  return entry.split('-').slice(0, 2).join('-');
}

/**
 * The release file an entry's url points to, or null when it isn't a file of
 * this release. tauri-action writes the API address of the asset
 * (api.github.com/repos/<repo>/releases/assets/<id>); a plain download link
 * (github.com/<repo>/releases/download/<tag>/<name>) is accepted too.
 */
export function releaseFileName(url, { repo, tag, assets }) {
  if (typeof url !== 'string') return null;
  const api = `https://api.github.com/repos/${repo}/releases/assets/`;
  const web = `https://github.com/${repo}/releases/download/${tag}/`;
  if (url.startsWith(api)) {
    const id = url.slice(api.length);
    if (!/^[0-9]+$/.test(id)) return null;
    return assets.find((a) => String(a.id) === id)?.name ?? null;
  }
  if (url.startsWith(web)) {
    const name = decodeURIComponent(url.slice(web.length));
    return assets.some((a) => a.name === name) ? name : null;
  }
  return null;
}

function releaseInfo(assetsPath, repo, tag) {
  const assets = JSON.parse(readFileSync(assetsPath, 'utf8'));
  if (!Array.isArray(assets)) throw new Error('The asset list is not a list');
  return { repo, tag, assets };
}

function entryFiles(manifest, release) {
  return Object.entries(manifest.platforms ?? {}).map(([entry, value]) => {
    const name = releaseFileName(value?.url, release);
    if (!name || /[/\\]/.test(name) || name === '.' || name === '..') {
      throw new Error(`${entry}: the url is not a file of the ${release.tag} release`);
    }
    return { entry, name, signature: value.signature };
  });
}

function findSigs(dir) {
  const out = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...findSigs(p));
    else if (name.endsWith('.sig')) out.push(p);
  }
  return out;
}

export function verifyDir(dir, pubText) {
  const sigs = findSigs(dir);
  if (sigs.length === 0) throw new Error(`No update signatures under ${dir}`);
  for (const sigPath of sigs) {
    const file = sigPath.slice(0, -'.sig'.length);
    verifyUpdateSignature(readFileSync(file), readFileSync(sigPath, 'utf8'), pubText);
    console.log(`ok  ${basename(file)}`);
  }
  return sigs.length;
}

export function checkRelease(dir, release, platforms) {
  const manifest = JSON.parse(readFileSync(join(dir, 'latest.json'), 'utf8'));
  if (!manifest.version) throw new Error('latest.json has no version');
  if (`v${manifest.version}` !== release.tag) {
    throw new Error(`latest.json is for version ${manifest.version}, not ${release.tag}`);
  }
  for (const p of platforms) {
    if (!manifest.platforms?.[p]) throw new Error(`latest.json has no ${p} entry`);
  }
  const entries = entryFiles(manifest, release);
  for (const { entry, name, signature } of entries) {
    const pub = readFileSync(join(dir, `update-key-${keyPlatform(entry)}.pub`), 'utf8');
    const trusted = verifyUpdateSignature(readFileSync(join(dir, name)), signature, pub);
    if (!trusted.split('\t').includes(`version:${manifest.version}`)) {
      throw new Error(`${entry}: the signature is not for version ${manifest.version}`);
    }
    console.log(`ok  ${entry}  ${name}`);
  }
  return entries.length;
}

function main(argv) {
  const [cmd, ...args] = argv;
  if (cmd === 'verify-dir' && args.length === 2) {
    verifyDir(args[0], readFileSync(args[1], 'utf8'));
  } else if (cmd === 'release-files' && args.length === 4) {
    const manifest = JSON.parse(readFileSync(args[0], 'utf8'));
    const release = releaseInfo(args[1], args[2], args[3]);
    for (const n of new Set(entryFiles(manifest, release).map((f) => f.name))) console.log(n);
  } else if (cmd === 'check-release' && args.length >= 5) {
    checkRelease(args[0], releaseInfo(args[1], args[2], args[3]), args.slice(4));
  } else {
    console.error(
      'usage: update-signature.mjs verify-dir <dir> <key.pub>' +
        ' | release-files <latest.json> <assets.json> <owner/repo> <tag>' +
        ' | check-release <dir> <assets.json> <owner/repo> <tag> <platform>...',
    );
    process.exit(2);
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  try {
    main(process.argv.slice(2));
  } catch (e) {
    console.error(`::error::${e instanceof Error ? e.message : String(e)}`);
    process.exit(1);
  }
}
