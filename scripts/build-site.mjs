// Build the GreenCLI website (https://choaterboater.github.io/GreenCli/).
//
//   npm run site            build it into site-dist/
//   npm run site:preview    build it, then serve it on http://127.0.0.1:4173/
//
// Every run reads the repo's own files, so nothing is ever copied by hand:
//   docs/SETUP.md            → guide/       the full guide, one page with a menu
//   src/data/helpContent.ts  → help/        the in-app help topics (Mac and Windows keys)
//   CHANGELOG.md             → whats-new/
//   docs/screenshots/*.png   → screenshots/ (plus small copies in screenshots/thumbs/)
//   site/                    → the page shell, the landing page, the CSS and the JS
// The download buttons link to the files of the latest published release,
// read from the GitHub API at build time (with GITHUB_TOKEN when it is set).
// If that fails, they link to the Releases page instead. The pages never call
// out to anything: no outside scripts, fonts or tracking.
//
// Options (flag or env var):
//   --out <dir>     SITE_OUT           where the site goes (default site-dist; emptied first)
//   --shots <dir>   SITE_SHOTS         photos to use instead of docs/screenshots, e.g. fresh
//                                      ones from `npm run screenshots -- --out <dir>`. A photo
//                                      missing there comes from docs/screenshots.
//                   SITE_RELEASE_JSON  a release as the GitHub API gives it (a file path or
//                                      the JSON itself), instead of asking GitHub
//                   SITE_URL           where the site lives (default
//                                      https://choaterboater.github.io/GreenCli/)
//   --serve         SITE_PORT          serve the site after the build (default port 4173)
// Behind a web proxy, set NODE_USE_ENV_PROXY=1 so the GitHub API call uses it.

import { createServer } from 'node:http';
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, extname, join, posix, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import Markdown, { defaultUrlTransform } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import ts from 'typescript';
import * as lucide from 'lucide-react';
import { shots as shotList } from './screenshots/shots.mjs';
import { scalePng } from './screenshots/png.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const REPO = 'Choaterboater/GreenCli';
const REPO_URL = `https://github.com/${REPO}`;
const RELEASES_URL = `${REPO_URL}/releases`;
const BLOB_URL = `${REPO_URL}/blob/main`;
const THUMB_FACTOR = 3; // photo grid copies: 2880 x 1800 → 960 x 600

function option(flag, env, fallback) {
  const i = process.argv.indexOf(flag);
  if (i !== -1 && process.argv[i + 1]) return process.argv[i + 1];
  return process.env[env] || fallback;
}

function warn(message) {
  // In GitHub Actions this shows on the run's summary page.
  console.warn(process.env.GITHUB_ACTIONS ? `::warning::${message}` : `warning: ${message}`);
}

function fail(message) {
  console.error(process.env.GITHUB_ACTIONS ? `::error::${message}` : `error: ${message}`);
  process.exit(1);
}

const outDir = resolve(option('--out', 'SITE_OUT', 'site-dist'));
const docsShots = join(root, 'docs', 'screenshots');
const shotsDir = resolve(option('--shots', 'SITE_SHOTS', docsShots));
const serve = process.argv.includes('--serve');
let siteUrl = option('--site-url', 'SITE_URL', 'https://choaterboater.github.io/GreenCli/');
if (!siteUrl.endsWith('/')) siteUrl += '/';
let basePath;
try {
  const u = new URL(siteUrl);
  if (u.protocol !== 'https:' && u.protocol !== 'http:') throw new Error('not a web address');
  basePath = u.pathname;
} catch {
  fail(`SITE_URL "${siteUrl}" is not a web address.`);
}

// The output folder is emptied first, so never let it be the repo or one of
// its source folders.
const keep = ['', 'src', 'src-tauri', 'docs', 'scripts', 'site', 'e2e', '.github', 'node_modules', 'dist'];
if (keep.some((d) => outDir === join(root, d)) || root.startsWith(outDir + sep) || outDir === dirname(outDir)) {
  fail(`Won't build the site into ${outDir}: it would delete files there. Pick a new folder.`);
}
// Any other folder must be new, empty or an earlier build of this site.
if (
  existsSync(outDir) &&
  readdirSync(outDir).length &&
  !(existsSync(join(outDir, 'index.html')) && existsSync(join(outDir, 'assets', 'site.css')))
) {
  fail(`Won't build the site into ${outDir}: it has other files in it. Pick an empty or new folder.`);
}

// ── Small HTML helpers ──

const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ESC[c]);
const unesc = (s) =>
  s.replace(/&(amp|lt|gt|quot|#39);/g, (_, e) => ({ amp: '&', lt: '<', gt: '>', quot: '"', '#39': "'" })[e]);

/** An icon from lucide-react (the app's own icon set) as inline SVG. */
function icon(name) {
  const Icon = lucide[name];
  if (!Icon) throw new Error(`lucide-react has no icon named "${name}".`);
  return renderToStaticMarkup(createElement(Icon, { 'aria-hidden': 'true', focusable: 'false' }));
}

/**
 * Fill a template from site/. Two braces take text (escaped here), three
 * braces take HTML this script made, and three braces with "icon:Name" an
 * icon. A name with no value stops the build.
 */
function fill(template, values, name) {
  return template.replace(/\{\{\{\s*([\w:-]+)\s*\}\}\}|\{\{\s*([\w:-]+)\s*\}\}/g, (_, rawKey, textKey) => {
    const key = rawKey || textKey;
    if (rawKey && key.startsWith('icon:')) return icon(key.slice(5));
    if (!(key in values)) throw new Error(`${name}: nothing to put in {{${key}}}.`);
    return rawKey ? values[key] : esc(values[key]);
  });
}

/** A template from site/, without its first comment (the note for whoever edits it). */
function template(file) {
  return readFileSync(join(root, 'site', file), 'utf8').replace(/<!--[\s\S]*?-->\s*/, '');
}

/** "October 2, 2026" from "2026-10-02" or an ISO time. */
function longDate(value) {
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric', timeZone: 'UTC' });
}

/** Markdown inline marks the help text uses: `code`, **bold** and *italic*. */
function inline(text) {
  let out = '';
  let last = 0;
  for (const m of text.matchAll(/`[^`]+`|\*\*[^*]+\*\*|\*[^*\s][^*]*\*/g)) {
    out += esc(text.slice(last, m.index));
    const t = m[0];
    if (t.startsWith('`')) out += `<code>${esc(t.slice(1, -1))}</code>`;
    else if (t.startsWith('**')) out += `<strong>${esc(t.slice(2, -2))}</strong>`;
    else out += `<em>${esc(t.slice(1, -1))}</em>`;
    last = m.index + t.length;
  }
  return out + esc(text.slice(last));
}

const slug = (text) =>
  text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s_-]/gu, '')
    .trim()
    .replace(/\s+/g, '-') || 'part';

const textOf = (node) => (node.type === 'text' ? node.value : (node.children || []).map(textOf).join(''));

// ── Photos ──

/** Width and height of a PNG, from its header. */
function pngSize(buf) {
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
}

/** Copy the photos and make the small copies. Returns them in show order. */
function preparePhotos() {
  const dir = join(outDir, 'screenshots');
  mkdirSync(join(dir, 'thumbs'), { recursive: true });
  const listed = shotList.map((s) => s.file);
  const extra = existsSync(shotsDir)
    ? readdirSync(shotsDir).filter((f) => f.endsWith('.png') && !listed.includes(f)).sort()
    : [];
  const photos = [];
  for (const file of [...listed, ...extra]) {
    let from = join(shotsDir, file);
    if (!existsSync(from)) {
      const fallback = join(docsShots, file);
      if (!existsSync(fallback)) {
        warn(`No photo ${file}; the site leaves it out.`);
        continue;
      }
      if (shotsDir !== docsShots) warn(`${file} is not in ${shotsDir}; using the one in docs/screenshots.`);
      from = fallback;
    }
    const png = readFileSync(from);
    copyFileSync(from, join(dir, file));
    const thumb = scalePng(png, THUMB_FACTOR);
    if (!thumb) throw new Error(`Can't read ${from} (only 8-bit RGB, RGBA and palette PNGs).`);
    writeFileSync(join(dir, 'thumbs', file), thumb);
    const about = shotList.find((s) => s.file === file)?.about || file.replace(/^\d+-|\.png$/g, '').replace(/-/g, ' ');
    // "Settings, Updates: version 2.0.0 …" → title "Settings, Updates", text "Version 2.0.0 …"
    const cut = about.indexOf(': ');
    const title = cut > 0 ? about.slice(0, cut) : about;
    const rest = cut > 0 ? about.slice(cut + 2) : '';
    photos.push({
      file,
      about,
      title,
      text: rest ? rest[0].toUpperCase() + rest.slice(1) : '',
      size: pngSize(png),
      thumbSize: pngSize(thumb),
    });
  }
  if (!photos.length) throw new Error(`No photos found in ${shotsDir} or docs/screenshots.`);
  return photos;
}

/** A photo that opens big when clicked (site.js), or as a plain link without JS. */
function zoomLink(photo, base, { hero = false, className = '' } = {}) {
  const full = `${base}screenshots/${photo.file}`;
  const thumb = `${base}screenshots/thumbs/${photo.file}`;
  const img = hero
    ? `<img src="${esc(full)}" srcset="${esc(thumb)} ${photo.thumbSize.width}w, ${esc(full)} ${photo.size.width}w" ` +
      `sizes="(min-width: 1000px) 660px, calc(100vw - 32px)" width="${photo.size.width}" height="${photo.size.height}" ` +
      `alt="${esc(photo.about)}" fetchpriority="high">`
    : `<img src="${esc(thumb)}" width="${photo.thumbSize.width}" height="${photo.thumbSize.height}" ` +
      `alt="${esc(photo.about)}" loading="lazy" decoding="async">`;
  const cls = className ? ` class="${className}"` : '';
  return `<a${cls} href="${esc(full)}" data-zoom data-caption="${esc(photo.about.replace(/`/g, ''))}">${img}</a>`;
}

function galleryHtml(photos, base) {
  const items = photos.map(
    (p) =>
      `<figure class="shot">${zoomLink(p, base)}<figcaption><strong>${inline(p.title)}</strong>${inline(p.text)}</figcaption></figure>`,
  );
  return `<div class="gallery">\n${items.join('\n')}\n</div>`;
}

// ── The latest release ──

/** The release, checked, or null (then the buttons go to the Releases page). */
async function readRelease() {
  const given = process.env.SITE_RELEASE_JSON;
  try {
    let data;
    if (given) {
      data = JSON.parse(given.trim().startsWith('{') ? given : readFileSync(resolve(given), 'utf8'));
    } else {
      const headers = {
        accept: 'application/vnd.github+json',
        'user-agent': 'greencli-site-build',
        'x-github-api-version': '2022-11-28',
      };
      if (process.env.GITHUB_TOKEN) headers.authorization = `Bearer ${process.env.GITHUB_TOKEN}`;
      const res = await fetch(`https://api.github.com/repos/${REPO}/releases/latest`, {
        headers,
        signal: AbortSignal.timeout(20000),
      });
      if (!res.ok) throw new Error(`GitHub answered ${res.status}`);
      data = await res.json();
    }
    const tag = typeof data?.tag_name === 'string' ? data.tag_name : '';
    const version = tag.replace(/^v/, '');
    if (!/^\d+\.\d+\.\d+([-+][\w.]+)?$/.test(version)) throw new Error(`the tag "${tag}" is not a version`);
    // Only files of this repo's releases, so a bad answer can't send people elsewhere.
    const prefix = `${RELEASES_URL}/download/`;
    const assets = (Array.isArray(data.assets) ? data.assets : [])
      .filter((a) => typeof a?.name === 'string' && typeof a.browser_download_url === 'string')
      .filter((a) => a.browser_download_url.startsWith(prefix))
      .map((a) => ({ name: a.name, url: a.browser_download_url, size: Number(a.size) || 0 }));
    const page =
      typeof data.html_url === 'string' && data.html_url.startsWith(`${RELEASES_URL}/`) ? data.html_url : `${RELEASES_URL}/latest`;
    return { version, assets, page, date: longDate(data.published_at || '') };
  } catch (e) {
    warn(`Couldn't read the latest release (${e.message}). The download buttons go to the Releases page.`);
    return null;
  }
}

const DOWNLOADS = [
  {
    os: 'macOS',
    icon: 'Laptop',
    sub: 'Apple Silicon (M1 and newer)',
    files: [{ label: 'Download .dmg', match: /(aarch64|arm64)\.dmg$/i }],
  },
  {
    os: 'macOS',
    icon: 'Laptop',
    sub: 'Intel',
    files: [{ label: 'Download .dmg', match: /(x64|x86_64|intel)\.dmg$/i }],
  },
  {
    os: 'Windows',
    icon: 'Monitor',
    sub: 'Windows 10 and 11 (64-bit)',
    files: [
      { label: 'Download .msi', match: /\.msi$/i },
      { label: 'Download setup .exe', match: /setup\.exe$/i },
    ],
  },
];

function downloadsHtml(release) {
  const cards = DOWNLOADS.map((card) => {
    const buttons = [];
    const names = [];
    card.files.forEach((f, i) => {
      const asset = release?.assets.find((a) => f.match.test(a.name));
      const cls = i === 0 ? 'btn btn-primary' : 'btn';
      if (asset) {
        buttons.push(`<a class="${cls}" href="${esc(asset.url)}">${icon('Download')}${esc(f.label)}</a>`);
        const mb = asset.size ? ` · ${Math.max(1, Math.round(asset.size / 1048576))} MB` : '';
        names.push(`${esc(asset.name)}${mb}`);
      } else {
        const href = release?.page || `${RELEASES_URL}/latest`;
        buttons.push(`<a class="${cls}" href="${esc(href)}">${icon('Download')}${esc(f.label.replace('Download', 'Get the'))}</a>`);
        names.push('On the release page');
      }
    });
    return (
      `<div class="dl-card"><h3>${icon(card.icon)}${esc(card.os)}</h3><p class="dl-sub">${esc(card.sub)}</p>` +
      `<div class="dl-buttons">${buttons.join('')}</div>` +
      `<p class="dl-file">${[...new Set(names)].join('<br>')}</p></div>`
    );
  });
  return `<div class="dl-grid">\n${cards.join('\n')}\n</div>`;
}

// ── Markdown pages ──

/** Map a link in a repo Markdown file (at repo path `from`) to the site. */
function siteLink(url, from, base) {
  if (!url || url.startsWith('#') || url.startsWith('//') || /^[a-z][a-z\d+.-]*:/i.test(url)) return url;
  const at = url.indexOf('#');
  const path = at === -1 ? url : url.slice(0, at);
  const hash = at === -1 ? '' : url.slice(at);
  const target = posix.normalize(posix.join(posix.dirname(from), path));
  if (target.startsWith('../')) return '';
  if (target === 'docs/SETUP.md') return `${base}guide/${hash}`;
  if (target === 'CHANGELOG.md') return `${base}whats-new/${hash}`;
  const shot = /^docs\/screenshots\/([\w.-]+\.png)$/.exec(target);
  if (shot) return `${base}screenshots/${shot[1]}`;
  return `${BLOB_URL}/${target}${hash}`;
}

/**
 * Markdown → HTML with GitHub's rules (tables and so on). Raw HTML in the
 * Markdown shows as text and unsafe links are dropped (react-markdown's
 * defaults); React escapes all text. Returns the HTML and the menu items.
 */
function renderMarkdown(md, { from, base, photos, levels = [2, 3], idFor }) {
  const toc = [];
  const used = new Map();
  const heading = (tag) =>
    function Heading({ node, children }) {
      const text = textOf(node).trim();
      let id = (idFor && idFor(text)) || slug(text);
      const n = used.get(id) || 0;
      used.set(id, n + 1);
      if (n) id = `${id}-${n}`;
      if (levels.includes(Number(tag[1]))) toc.push({ level: Number(tag[1]), id, text });
      const anchor = createElement('a', { className: 'anchor', href: `#${id}`, 'aria-label': `Link to "${text}"` }, '#');
      return createElement(tag, { id }, children, anchor);
    };
  const components = {
    h1: heading('h2'),
    h2: heading('h2'),
    h3: heading('h3'),
    h4: heading('h4'),
    a: ({ href, children }) => createElement('a', { href }, children),
    // Wide tables scroll inside their box, never the page. No inline styles (the CSP forbids them).
    table: ({ children }) => createElement('div', { className: 'table-wrap' }, createElement('table', null, children)),
    th: ({ children }) => createElement('th', null, children),
    td: ({ children }) => createElement('td', null, children),
    img: ({ src, alt }) => {
      const m = /screenshots\/([\w.-]+\.png)$/.exec(src || '');
      const photo = m && photos.find((p) => p.file === m[1]);
      if (photo) {
        return createElement('span', {
          className: 'zoom-wrap',
          dangerouslySetInnerHTML: { __html: zoomLink(photo, base, { className: 'zoom' }) },
        });
      }
      return createElement('img', { src, alt: alt || '', loading: 'lazy', decoding: 'async' });
    },
  };
  const html = renderToStaticMarkup(
    createElement(Markdown, {
      remarkPlugins: [remarkGfm],
      components,
      urlTransform: (url) => siteLink(defaultUrlTransform(url), from, base),
      children: md,
    }),
  );
  return { html, toc };
}

/** "# Title" off the top of a Markdown file: { title, rest }. */
function splitTitle(md, file) {
  const m = /^# (.+)\r?\n/.exec(md);
  if (!m) throw new Error(`${file} should start with a "# Title" line.`);
  return { title: m[1].trim(), rest: md.slice(m[0].length) };
}

/** The text before the first "## " heading, and the rest. */
function splitIntro(md) {
  const at = md.search(/^## /m);
  return at === -1 ? { intro: md, body: '' } : { intro: md.slice(0, at), body: md.slice(at) };
}

function tocHtml(items) {
  const li = items.map(
    (t) => `<li${t.level > 2 ? ' class="sub"' : ''}><a href="#${esc(t.id)}">${t.icon || ''}${esc(t.text)}</a></li>`,
  );
  return `<ul>\n${li.join('\n')}\n</ul>`;
}

// ── Help topics (src/data/helpContent.ts) ──

/**
 * HELP_TOPICS as the app builds them on `os` ('mac' or 'windows'). The file is
 * TypeScript, so it is compiled with the repo's own TypeScript and run in a
 * sandbox whose navigator says which system it is. Icons come back as their
 * lucide names.
 */
function loadHelpTopics(os) {
  const context = vm.createContext({ navigator: { platform: os === 'mac' ? 'MacIntel' : 'Win32' } });
  const cache = new Map();
  const load = (file) => {
    if (cache.has(file)) return cache.get(file).exports;
    const { outputText } = ts.transpileModule(readFileSync(file, 'utf8'), {
      fileName: file,
      compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
    });
    const module = { exports: {} };
    cache.set(file, module);
    const run = vm.runInContext(`(function (exports, require, module) {\n${outputText}\n})`, context, { filename: file });
    const require = (spec) => {
      if (spec === 'lucide-react') return new Proxy({}, { get: (_, name) => (typeof name === 'string' ? name : undefined) });
      if (spec.startsWith('.')) {
        const base = resolve(dirname(file), spec);
        return load(existsSync(`${base}.ts`) ? `${base}.ts` : `${base}.tsx`);
      }
      throw new Error(`${relative(root, file)} imports "${spec}", which the site build can't load. Teach scripts/build-site.mjs about it.`);
    };
    run(module.exports, require, module);
    return module.exports;
  };
  const topics = load(join(root, 'src', 'data', 'helpContent.ts')).HELP_TOPICS;
  if (!Array.isArray(topics) || !topics.length) throw new Error('src/data/helpContent.ts has no HELP_TOPICS.');
  return JSON.parse(JSON.stringify(topics));
}

function helpBlocks(topic) {
  return topic.blocks
    .map((b) => {
      const items = () => (b.items || []).map((it) => `<li>${inline(it)}</li>`).join('\n');
      switch (b.kind) {
        case 'p':
          return `<p>${inline(b.text || '')}</p>`;
        case 'steps':
          return `<ol>\n${items()}\n</ol>`;
        case 'bullets':
          return `<ul>\n${items()}\n</ul>`;
        case 'code':
          return `<pre><code>${esc(b.text || '')}</code></pre>`;
        case 'note':
          return `<div class="note"><p>${inline(b.text || '')}</p></div>`;
        default:
          throw new Error(`Help topic "${topic.id}" has a block of kind "${b.kind}" the site doesn't know.`);
      }
    })
    .join('\n');
}

function helpPage() {
  const mac = loadHelpTopics('mac');
  const win = loadHelpTopics('windows');
  const toc = [];
  const sections = mac.map((t) => {
    const w = win.find((x) => x.id === t.id) || t;
    const badge = `<span class="feature-icon">${icon(t.icon)}</span>`;
    toc.push({ level: 2, id: t.id, text: t.title, icon: icon(t.icon) });
    const onMac = helpBlocks(t);
    const onWin = helpBlocks(w);
    const body =
      onMac === onWin
        ? onMac
        : `<div class="os-mac"><p class="os-label">On a Mac</p>\n${onMac}\n</div>\n` +
          `<div class="os-win"><p class="os-label">On Windows</p>\n${onWin}\n</div>`;
    return (
      `<section class="topic" id="${esc(t.id)}">\n<h2>${badge}${esc(t.title)}` +
      `<a class="anchor" href="#${esc(t.id)}" aria-label="Link to &quot;${esc(t.title)}&quot;">#</a></h2>\n` +
      `<p class="summary">${inline(t.summary)}</p>\n${body}\n</section>`
    );
  });
  const intro =
    '<p class="intro">The same help as in the app. In GreenCLI, press F1 (or click ? in the title bar) to open it.</p>\n' +
    '<div class="os-switch" role="group" aria-label="Show the keys for">' +
    '<span>Show the keys for:</span>' +
    '<button type="button" data-os-pick="mac" aria-pressed="true">Mac</button>' +
    '<button type="button" data-os-pick="win" aria-pressed="false">Windows</button></div>';
  return { toc, intro, content: sections.join('\n'), count: mac.length };
}

// ── Pages ──

function page(file, { title, description, body, nav = '' }) {
  const depth = file.split('/').length - 1;
  const base = file === '404.html' ? basePath : '../'.repeat(depth) || './';
  const canonicalPath = file.replace(/(^|\/)index\.html$/, '$1');
  const current = (name) => (nav === name ? ' aria-current="page"' : '');
  const html = fill(
    layout,
    {
      title,
      description,
      base,
      canonical: siteUrl + canonicalPath,
      ogImage: `${siteUrl}screenshots/${ogPhoto}`,
      repoUrl: REPO_URL,
      body,
      navGuide: current('guide'),
      navHelp: current('help'),
      navNew: current('new'),
    },
    'site/layout.html',
  );
  mkdirSync(dirname(join(outDir, file)), { recursive: true });
  writeFileSync(join(outDir, file), html);
  pages.set(file, html);
}

function docPage(file, { title, description, heading, intro, toc, content, source, nav }) {
  const body = fill(
    docTemplate,
    {
      heading,
      intro,
      toc: tocHtml(toc),
      content,
      sourceUrl: `${BLOB_URL}/${source}`,
      sourceName: source,
    },
    'site/doc.html',
  );
  page(file, { title, description, body, nav });
}

/** Every link and photo on the site goes somewhere real, and no id is used twice. */
function checkLinks() {
  const problems = [];
  const ids = new Map();
  for (const [file, html] of pages) {
    const seen = new Set();
    for (const m of html.matchAll(/\sid="([^"]*)"/g)) {
      const id = unesc(m[1]);
      if (seen.has(id)) problems.push(`${file}: the id "${id}" is used twice`);
      seen.add(id);
    }
    ids.set(file, seen);
  }
  for (const [file, html] of pages) {
    const urls = [
      ...[...html.matchAll(/\s(?:href|src)="([^"]*)"/g)].map((m) => unesc(m[1])),
      ...[...html.matchAll(/\ssrcset="([^"]*)"/g)].flatMap((m) =>
        unesc(m[1])
          .split(',')
          .map((s) => s.trim().split(/\s+/)[0]),
      ),
    ];
    for (const url of urls) {
      if (/^(https?:|mailto:)/.test(url)) continue;
      if (!url) {
        problems.push(`${file}: an empty link (a link the Markdown had that goes nowhere?)`);
        continue;
      }
      const at = url.indexOf('#');
      const path = at === -1 ? url : url.slice(0, at);
      const hash = at === -1 ? '' : decodeURIComponent(url.slice(at + 1));
      let target = file;
      if (path) {
        let rel;
        if (path.startsWith('/')) rel = path.startsWith(basePath) ? path.slice(basePath.length) : null;
        else rel = posix.normalize(posix.join(posix.dirname(file), path));
        if (rel === null || rel.startsWith('..')) {
          problems.push(`${file}: "${url}" points outside the site`);
          continue;
        }
        if (rel === '' || rel === '.' || rel.endsWith('/')) rel = posix.normalize(`${rel}/index.html`);
        target = rel.replace(/^\.?\//, '');
      }
      if (!existsSync(join(outDir, target))) problems.push(`${file}: "${url}" goes to a missing file`);
      else if (hash && pages.has(target) && !ids.get(target).has(hash)) problems.push(`${file}: "${url}" has no such part`);
    }
  }
  return problems;
}

// ── Build ──

const started = Date.now();
const pages = new Map();
const layout = template('layout.html');
const docTemplate = template('doc.html');

rmSync(outDir, { recursive: true, force: true });
mkdirSync(join(outDir, 'assets'), { recursive: true });

const photos = preparePhotos();
const ogPhoto = photos[0].file;
const release = await readRelease();

// Guide: docs/SETUP.md
const setup = splitTitle(readFileSync(join(root, 'docs', 'SETUP.md'), 'utf8'), 'docs/SETUP.md');
const setupParts = splitIntro(setup.rest);
const md = (text, opts) => renderMarkdown(text, { from: 'docs/SETUP.md', base: '../', photos, ...opts });
const guide = md(setupParts.body);
docPage('guide/index.html', {
  title: 'Guide · GreenCLI',
  description: 'How to install, set up and use GreenCLI: connecting, the vault, the AI helper, MCP servers, the Config Editor and more.',
  heading: setup.title,
  intro: `<div class="intro">${md(setupParts.intro).html}</div>`,
  toc: guide.toc,
  content: guide.html,
  source: 'docs/SETUP.md',
  nav: 'guide',
});

// What's new: CHANGELOG.md, newest first. "## [2.0.0] - 2026-10-02" → "2.0.0 — October 2, 2026"
// (id v2.0.0). An empty [Unreleased] part is left out.
const changelog = splitIntro(splitTitle(readFileSync(join(root, 'CHANGELOG.md'), 'utf8'), 'CHANGELOG.md').rest).body
  .replace(/^## \[Unreleased\][^\n]*\n([\s\S]*?)(?=^## )/m, (_, inner) =>
    inner.trim() ? `## Coming next (not released yet)\n\n${inner.trim()}\n\n` : '',
  )
  .replace(/^## \[([^\]]+)\](?: - (\d{4}-\d{2}-\d{2}))?[^\n]*$/gm, (_, v, d) => `## ${v}${d ? ` — ${longDate(d)}` : ''}`);
const news = renderMarkdown(changelog, {
  from: 'CHANGELOG.md',
  base: '../',
  photos,
  levels: [2],
  idFor: (text) => {
    const v = /^\d+\.\d+\.\d+\S*/.exec(text);
    return v ? `v${v[0]}` : null;
  },
});
docPage('whats-new/index.html', {
  title: "What's new · GreenCLI",
  description: 'Every change to GreenCLI, version by version.',
  heading: "What's new",
  intro: '<p class="intro">Every GreenCLI version, newest first.</p>',
  toc: news.toc,
  content: news.html,
  source: 'CHANGELOG.md',
  nav: 'new',
});

// Help: src/data/helpContent.ts
const help = helpPage();
docPage('help/index.html', {
  title: 'Help topics · GreenCLI',
  description: 'The GreenCLI help topics, the same as F1 in the app, with the keys for Mac or Windows.',
  heading: 'Help topics',
  intro: help.intro,
  toc: help.toc,
  content: help.content,
  source: 'src/data/helpContent.ts',
  nav: 'help',
});

// Landing page. Without the release, show the version in package.json.
const pkgVersion = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).version;
const version = release?.version || pkgVersion;
const changelogDate = new RegExp(`^## \\[${version.replace(/\./g, '\\.')}\\] - (\\d{4}-\\d{2}-\\d{2})`, 'm').exec(
  readFileSync(join(root, 'CHANGELOG.md'), 'utf8'),
);
const dateText = release?.date || (changelogDate ? longDate(changelogDate[1]) : '');
const newsId = `v${version}`;
const homeBody = fill(
  template('home.html'),
  {
    version,
    dateText: dateText || 'latest release',
    heroImage: zoomLink(photos[0], '', { hero: true }),
    downloads: downloadsHtml(release),
    gallery: galleryHtml(photos, ''),
    whatsNewHref: news.toc.some((t) => t.id === newsId) ? `whats-new/#${newsId}` : 'whats-new/',
    allReleases: RELEASES_URL,
  },
  'site/home.html',
);
page('index.html', {
  title: 'GreenCLI: one app for Aruba, Juniper and Mist',
  description:
    'A desktop app for network engineers: terminal, config editor with safety checks, an AI helper that hides your secrets, MCP tools and safe changes. macOS and Windows.',
  body: homeBody,
});
page('404.html', {
  title: 'Page not found · GreenCLI',
  description: 'This page is not on the GreenCLI site.',
  body: fill(template('404.html'), { base: basePath }, 'site/404.html'),
});

// Assets: the CSS and JS from site/, the app icon from src-tauri/icons/.
copyFileSync(join(root, 'site', 'site.css'), join(outDir, 'assets', 'site.css'));
copyFileSync(join(root, 'site', 'site.js'), join(outDir, 'assets', 'site.js'));
copyFileSync(join(root, 'src-tauri', 'icons', 'icon.svg'), join(outDir, 'assets', 'icon.svg'));
copyFileSync(join(root, 'src-tauri', 'icons', '128x128@2x.png'), join(outDir, 'assets', 'icon-256.png'));

const problems = checkLinks();
if (problems.length) {
  for (const p of problems) console.error(`  ${p}`);
  fail(`${problems.length} broken link(s) on the site.`);
}

console.log(
  `Site built in ${((Date.now() - started) / 1000).toFixed(1)} s: ${pages.size} pages, ${photos.length} photos, ` +
    `${help.count} help topics, ${news.toc.length} versions. ` +
    (release ? `Downloads: GreenCLI ${release.version} (${release.assets.length} files).` : 'Downloads: the Releases page.'),
);
console.log(`It is in ${outDir}`);

// ── Preview ──

if (serve) {
  const MIME = {
    '.html': 'text/html; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.svg': 'image/svg+xml',
    '.png': 'image/png',
  };
  const port = Number(process.env.SITE_PORT) || 4173;
  createServer((req, res) => {
    let path;
    try {
      path = decodeURIComponent((req.url || '/').split('?')[0]);
    } catch {
      res.statusCode = 400;
      res.end('Bad URL');
      return;
    }
    // Answer at / and at the real site's path (/GreenCli/), so the 404 page's links work too.
    if (path.startsWith(basePath)) path = `/${path.slice(basePath.length)}`;
    let file = join(outDir, path);
    if (file !== outDir && !file.startsWith(outDir + sep)) file = join(outDir, '404.html');
    if (existsSync(file) && statSync(file).isDirectory()) {
      if (!path.endsWith('/')) {
        res.writeHead(301, { location: `${req.url.split('?')[0]}/` });
        res.end();
        return;
      }
      file = join(file, 'index.html');
    }
    if (!existsSync(file)) {
      res.statusCode = 404;
      file = join(outDir, '404.html');
    }
    res.setHeader('content-type', MIME[extname(file)] || 'application/octet-stream');
    res.end(readFileSync(file));
  }).listen(port, '127.0.0.1', () => console.log(`Serving it on http://127.0.0.1:${port}/ (Ctrl+C stops it)`));
}
