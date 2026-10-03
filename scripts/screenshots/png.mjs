// Make a big screenshot PNG smaller with no extra packages: cut it to 256
// colors (median cut) and save it as a palette PNG. Screens of the app are
// mostly flat colors, so this looks the same and is about a third the size.
// The most used colors are kept exactly, so backgrounds and text stay true.
// scalePng also makes the small copies the website shows in its photo grid.

import { deflateSync, inflateSync } from 'node:zlib';

const CRC_TABLE = new Uint32Array(256).map((_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});

function crc32(buf) {
  let c = 0xffffffff;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(data.length, 0);
  head.write(type, 4, 'ascii');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), data])), 0);
  return Buffer.concat([head, data, crc]);
}

/**
 * Decode an 8-bit RGB or RGBA PNG (what Chromium writes) or an 8-bit palette
 * PNG (what shrinkPng writes) to RGB bytes. Other kinds give null.
 */
export function decodePng(png) {
  let pos = 8;
  let width = 0;
  let height = 0;
  let channels = 0; // bytes per pixel in the image data
  let plte = null;
  const idat = [];
  while (pos < png.length) {
    const len = png.readUInt32BE(pos);
    const type = png.toString('ascii', pos + 4, pos + 8);
    const data = png.subarray(pos + 8, pos + 8 + len);
    if (type === 'IHDR') {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      const depth = data[8];
      const colorType = data[9];
      if (depth !== 8 || (colorType !== 2 && colorType !== 3 && colorType !== 6) || data[12] !== 0) return null;
      channels = colorType === 6 ? 4 : colorType === 3 ? 1 : 3;
    } else if (type === 'PLTE') {
      plte = data;
    } else if (type === 'IDAT') {
      idat.push(data);
    }
    pos += 12 + len;
  }
  if (channels === 1 && !plte) return null;
  const raw = inflateSync(Buffer.concat(idat));
  const stride = width * channels;
  const out = Buffer.alloc(width * height * 3);
  let prev = Buffer.alloc(stride);
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)];
    const line = Buffer.from(raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1)));
    for (let i = 0; i < stride; i++) {
      const a = i >= channels ? line[i - channels] : 0;
      const b = prev[i];
      const c = i >= channels ? prev[i - channels] : 0;
      let add = 0;
      if (filter === 1) add = a;
      else if (filter === 2) add = b;
      else if (filter === 3) add = (a + b) >> 1;
      else if (filter === 4) {
        const p = a + b - c;
        const pa = Math.abs(p - a);
        const pb = Math.abs(p - b);
        const pc = Math.abs(p - c);
        add = pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
      }
      line[i] = (line[i] + add) & 0xff;
    }
    for (let x = 0; x < width; x++) {
      // A palette pixel is an index into PLTE (3 bytes per color).
      const src = channels === 1 ? plte : line;
      const at = channels === 1 ? line[x] * 3 : x * channels;
      out[(y * width + x) * 3] = src[at];
      out[(y * width + x) * 3 + 1] = src[at + 1];
      out[(y * width + x) * 3 + 2] = src[at + 2];
    }
    prev = line;
  }
  return { width, height, rgb: out };
}

/** Pick up to 256 colors: the most used ones as they are, the rest by median cut. */
function palette(counts, keepExact = 48, size = 256) {
  const all = [...counts.entries()].sort((p, q) => q[1] - p[1]);
  const exact = all.slice(0, keepExact).map(([c]) => c);
  const rest = all.slice(keepExact);
  const ch = (c, k) => (c >> (16 - 8 * k)) & 0xff;
  let boxes = rest.length ? [rest] : [];
  while (boxes.length && boxes.length < size - exact.length) {
    // Split the box with the most pixels times the widest spread.
    let best = -1;
    let bestScore = 0;
    let bestCh = 0;
    boxes.forEach((box, i) => {
      if (box.length < 2) return;
      let n = 0;
      const lo = [255, 255, 255];
      const hi = [0, 0, 0];
      for (const [c, w] of box) {
        n += w;
        for (let k = 0; k < 3; k++) {
          const v = ch(c, k);
          if (v < lo[k]) lo[k] = v;
          if (v > hi[k]) hi[k] = v;
        }
      }
      const spread = [0, 1, 2].map((k) => hi[k] - lo[k]);
      const k = spread.indexOf(Math.max(...spread));
      const score = n * spread[k];
      if (score > bestScore) {
        bestScore = score;
        best = i;
        bestCh = k;
      }
    });
    if (best === -1) break;
    const box = boxes[best].sort((p, q) => ch(p[0], bestCh) - ch(q[0], bestCh));
    const total = box.reduce((s, [, w]) => s + w, 0);
    let acc = 0;
    let cut = 1;
    for (; cut < box.length - 1; cut++) {
      acc += box[cut - 1][1];
      if (acc >= total / 2) break;
    }
    boxes.splice(best, 1, box.slice(0, cut), box.slice(cut));
  }
  const means = boxes.map((box) => {
    const s = [0, 0, 0];
    let n = 0;
    for (const [c, w] of box) {
      n += w;
      for (let k = 0; k < 3; k++) s[k] += ch(c, k) * w;
    }
    return (Math.round(s[0] / n) << 16) | (Math.round(s[1] / n) << 8) | Math.round(s[2] / n);
  });
  return [...exact, ...means];
}

/**
 * Return a smaller PNG for `png` (256 colors), or `png` itself when it can't
 * be read or the smaller one isn't smaller.
 */
export function shrinkPng(png) {
  const img = decodePng(png);
  if (!img) return png;
  const out = encodePalette(img);
  return out.length < png.length ? out : png;
}

/**
 * A copy of `png` made `factor` times smaller each way (each new pixel is the
 * average of a factor x factor block), with 256 colors. Null when `png` can't
 * be read.
 */
export function scalePng(png, factor) {
  const img = decodePng(png);
  if (!img) return null;
  const width = Math.max(1, Math.floor(img.width / factor));
  const height = Math.max(1, Math.floor(img.height / factor));
  const rgb = Buffer.alloc(width * height * 3);
  const n = factor * factor;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      let r = 0;
      let g = 0;
      let b = 0;
      for (let dy = 0; dy < factor; dy++) {
        const row = (y * factor + dy) * img.width;
        for (let dx = 0; dx < factor; dx++) {
          const i = (row + x * factor + dx) * 3;
          r += img.rgb[i];
          g += img.rgb[i + 1];
          b += img.rgb[i + 2];
        }
      }
      const o = (y * width + x) * 3;
      rgb[o] = Math.round(r / n);
      rgb[o + 1] = Math.round(g / n);
      rgb[o + 2] = Math.round(b / n);
    }
  }
  return encodePalette({ width, height, rgb });
}

/** Save RGB bytes as a 256-color palette PNG. */
function encodePalette({ width, height, rgb }) {
  const counts = new Map();
  for (let i = 0; i < rgb.length; i += 3) {
    const c = (rgb[i] << 16) | (rgb[i + 1] << 8) | rgb[i + 2];
    counts.set(c, (counts.get(c) || 0) + 1);
  }
  const pal = palette(counts);
  const pr = pal.map((c) => (c >> 16) & 0xff);
  const pg = pal.map((c) => (c >> 8) & 0xff);
  const pb = pal.map((c) => c & 0xff);
  const nearest = new Map();
  const indexOf = (c) => {
    let hit = nearest.get(c);
    if (hit !== undefined) return hit;
    const r = (c >> 16) & 0xff;
    const g = (c >> 8) & 0xff;
    const b = c & 0xff;
    let bestD = Infinity;
    for (let i = 0; i < pal.length; i++) {
      // Weighted for the eye: green counts most, blue least.
      const d = 3 * (r - pr[i]) ** 2 + 4 * (g - pg[i]) ** 2 + 2 * (b - pb[i]) ** 2;
      if (d < bestD) {
        bestD = d;
        hit = i;
      }
    }
    nearest.set(c, hit);
    return hit;
  };
  const rows = Buffer.alloc((width + 1) * height);
  for (let y = 0; y < height; y++) {
    rows[y * (width + 1)] = 0; // no filter: best for palette images
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 3;
      rows[y * (width + 1) + 1 + x] = indexOf((rgb[i] << 16) | (rgb[i + 1] << 8) | rgb[i + 2]);
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 3; // palette
  const plte = Buffer.alloc(pal.length * 3);
  pal.forEach((_, i) => {
    plte[i * 3] = pr[i];
    plte[i * 3 + 1] = pg[i];
    plte[i * 3 + 2] = pb[i];
  });
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('PLTE', plte),
    chunk('IDAT', deflateSync(rows, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}
