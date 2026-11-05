// Change an image's DPI without touching its pixels: only the resolution fields in the file header are rewritten.
// JPEG: JFIF APP0 density, EXIF IFD0 XResolution / YResolution / ResolutionUnit, Photoshop APP13 ResolutionInfo
// (all edited in place; a JFIF segment is added if the file has none). PNG: the pHYs chunk (replaced or added before
// the first IDAT). The compressed image data is copied byte for byte, so quality and pixel size never change.

export type DpiFormat = 'jpeg' | 'png';
export type DpiSource = 'photoshop' | 'exif' | 'jfif' | 'png';

export type DpiInfo = {
  format: DpiFormat;
  /** Resolution the file states, or null when it has none (apps then assume 72 or 96). */
  dpi: number | null;
  /** Where that value came from (the field most apps read first). */
  from: DpiSource | null;
  /** Every place the file stores a resolution, for the report. */
  fields: { where: DpiSource; dpi: number | null }[];
};

const be16 = (b: Uint8Array, o: number) => (b[o] << 8) | b[o + 1];
const be32 = (b: Uint8Array, o: number) => ((b[o] << 24) >>> 0) + (b[o + 1] << 16) + (b[o + 2] << 8) + b[o + 3];
const put16 = (b: Uint8Array, o: number, v: number) => {
  b[o] = (v >> 8) & 255;
  b[o + 1] = v & 255;
};
const put32 = (b: Uint8Array, o: number, v: number) => {
  b[o] = (v >>> 24) & 255;
  b[o + 1] = (v >>> 16) & 255;
  b[o + 2] = (v >>> 8) & 255;
  b[o + 3] = v & 255;
};
const ascii = (b: Uint8Array, o: number, s: string) => [...s].every((c, i) => b[o + i] === c.charCodeAt(0));
const round1 = (v: number) => Math.round(v * 10) / 10;

export function detectFormat(b: Uint8Array): DpiFormat | null {
  if (b[0] === 0xff && b[1] === 0xd8) return 'jpeg';
  if (b[0] === 0x89 && ascii(b, 1, 'PNG\r\n\x1a\n')) return 'png';
  return null;
}

// ---------- JPEG ----------

type Seg = { marker: number; start: number; data: number; end: number };

/** Marker segments before the image data (stops at SOS). */
function jpegSegments(b: Uint8Array): Seg[] {
  const segs: Seg[] = [];
  let p = 2;
  while (p + 4 <= b.length) {
    if (b[p] !== 0xff) break;
    const marker = b[p + 1];
    if (marker === 0xff) {
      p++;
      continue;
    }
    if (marker === 0xd8 || (marker >= 0xd0 && marker <= 0xd7) || marker === 0x01) {
      p += 2;
      continue;
    }
    const len = be16(b, p + 2);
    if (len < 2 || p + 2 + len > b.length) break;
    segs.push({ marker, start: p, data: p + 4, end: p + 2 + len });
    if (marker === 0xda) break;
    p += 2 + len;
  }
  return segs;
}

const isJfif = (b: Uint8Array, s: Seg) => s.marker === 0xe0 && s.end - s.data >= 12 && ascii(b, s.data, 'JFIF\0');
const isExif = (b: Uint8Array, s: Seg) => s.marker === 0xe1 && s.end - s.data >= 14 && ascii(b, s.data, 'Exif\0\0');
const isPhotoshop = (b: Uint8Array, s: Seg) => s.marker === 0xed && ascii(b, s.data, 'Photoshop 3.0\0');

/** EXIF IFD0 resolution entries: positions of the X/Y rationals and the unit short. */
function exifRes(b: Uint8Array, s: Seg) {
  const t = s.data + 6;
  const le = b[t] === 0x49;
  const u16 = (o: number) => (le ? b[o] | (b[o + 1] << 8) : be16(b, o));
  const u32 = (o: number) => (le ? (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16)) + ((b[o + 3] << 24) >>> 0) : be32(b, o));
  const ifd = t + u32(t + 4);
  if (ifd + 2 > s.end) return null;
  const n = u16(ifd);
  let x = -1, y = -1, unit = -1;
  for (let i = 0; i < n; i++) {
    const e = ifd + 2 + i * 12;
    if (e + 12 > s.end) break;
    const tag = u16(e);
    const type = u16(e + 2);
    if ((tag === 0x011a || tag === 0x011b) && type === 5) {
      const off = t + u32(e + 8);
      if (off + 8 <= s.end) tag === 0x011a ? (x = off) : (y = off);
    } else if (tag === 0x0128 && type === 3) unit = e + 8;
  }
  const rat = (o: number) => (o < 0 ? null : u32(o + 4) ? u32(o) / u32(o + 4) : null);
  const unitVal = unit < 0 ? 2 : u16(unit);
  let dpi = rat(x);
  if (dpi !== null && unitVal === 3) dpi *= 2.54;
  if (dpi !== null && unitVal === 1) dpi = null; // "no unit": an aspect ratio only
  return {
    dpi,
    write(v: number) {
      const w32 = (o: number, val: number) => (le ? [0, 1, 2, 3].forEach((k) => (b[o + k] = (val >>> (8 * k)) & 255)) : put32(b, o, val));
      for (const o of [x, y]) if (o >= 0) {
        w32(o, Math.round(v * 1000));
        w32(o + 4, 1000);
      }
      if (unit >= 0) le ? ((b[unit] = 2), (b[unit + 1] = 0)) : put16(b, unit, 2);
    },
    has: x >= 0 || y >= 0,
  };
}

/** Photoshop ResolutionInfo (8BIM 0x03ED) inside APP13: offset of its 16-byte data. */
function photoshopRes(b: Uint8Array, s: Seg) {
  let p = s.data + 14;
  while (p + 12 <= s.end) {
    if (!ascii(b, p, '8BIM')) return -1;
    const id = be16(b, p + 4);
    const nameLen = b[p + 6];
    let q = p + 6 + 1 + nameLen;
    if ((nameLen + 1) % 2) q++;
    const size = be32(b, q);
    const data = q + 4;
    if (id === 0x03ed && size >= 16 && data + 16 <= s.end) return data;
    p = data + size + (size % 2);
  }
  return -1;
}

function readJpeg(b: Uint8Array): DpiInfo {
  const fields: DpiInfo['fields'] = [];
  for (const s of jpegSegments(b)) {
    if (isPhotoshop(b, s)) {
      const o = photoshopRes(b, s);
      if (o >= 0) {
        const unit = be16(b, o + 4);
        const v = be32(b, o) / 65536;
        fields.push({ where: 'photoshop', dpi: unit === 2 ? v * 2.54 : v });
      }
    } else if (isExif(b, s)) {
      const r = exifRes(b, s);
      if (r?.has) fields.push({ where: 'exif', dpi: r.dpi });
    } else if (isJfif(b, s)) {
      const units = b[s.data + 7];
      const x = be16(b, s.data + 8);
      fields.push({ where: 'jfif', dpi: units === 1 ? x : units === 2 ? x * 2.54 : null });
    }
  }
  // Photoshop reads its own block first, most other apps read EXIF, then JFIF.
  const order: DpiSource[] = ['photoshop', 'exif', 'jfif'];
  const best = order.map((w) => fields.find((f) => f.where === w && f.dpi)).find(Boolean);
  return { format: 'jpeg', dpi: best?.dpi ? round1(best.dpi) : null, from: best?.where ?? null, fields };
}

function writeJpeg(src: Uint8Array, dpi: number): Uint8Array {
  const b = src.slice();
  const segs = jpegSegments(b);
  let hasJfif = false;
  for (const s of segs) {
    if (isJfif(b, s)) {
      hasJfif = true;
      b[s.data + 7] = 1;
      put16(b, s.data + 8, dpi);
      put16(b, s.data + 10, dpi);
    } else if (isExif(b, s)) exifRes(b, s)?.write(dpi);
    else if (isPhotoshop(b, s)) {
      const o = photoshopRes(b, s);
      if (o >= 0) {
        put32(b, o, dpi * 65536);
        put16(b, o + 4, 1);
        put32(b, o + 8, dpi * 65536);
        put16(b, o + 12, 1);
      }
    }
  }
  if (hasJfif) return b;
  // No JFIF segment: add one straight after the start marker (18 bytes).
  const app0 = new Uint8Array([0xff, 0xe0, 0, 16, 0x4a, 0x46, 0x49, 0x46, 0, 1, 2, 1, 0, 0, 0, 0, 0, 0]);
  put16(app0, 12, dpi);
  put16(app0, 14, dpi);
  const out = new Uint8Array(b.length + app0.length);
  out.set(b.subarray(0, 2), 0);
  out.set(app0, 2);
  out.set(b.subarray(2), 2 + app0.length);
  return out;
}

// ---------- PNG ----------

let crcTable: Uint32Array | null = null;
function crc32(b: Uint8Array, start: number, end: number) {
  if (!crcTable) {
    crcTable = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      crcTable[n] = c >>> 0;
    }
  }
  let c = 0xffffffff;
  for (let i = start; i < end; i++) c = crcTable[(c ^ b[i]) & 255] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

type Chunk = { type: string; start: number; data: number; len: number };
function pngChunks(b: Uint8Array): Chunk[] {
  const out: Chunk[] = [];
  let p = 8;
  while (p + 12 <= b.length) {
    const len = be32(b, p);
    const type = String.fromCharCode(b[p + 4], b[p + 5], b[p + 6], b[p + 7]);
    out.push({ type, start: p, data: p + 8, len });
    if (type === 'IEND') break;
    p += 12 + len;
  }
  return out;
}

function readPng(b: Uint8Array): DpiInfo {
  const c = pngChunks(b).find((k) => k.type === 'pHYs' && k.len >= 9);
  const dpi = c && b[c.data + 8] === 1 ? round1(be32(b, c.data) * 0.0254) : null;
  return { format: 'png', dpi, from: dpi ? 'png' : null, fields: c ? [{ where: 'png', dpi }] : [] };
}

function writePng(src: Uint8Array, dpi: number): Uint8Array {
  const ppm = Math.round(dpi / 0.0254);
  const chunk = new Uint8Array(21);
  put32(chunk, 0, 9);
  chunk.set([0x70, 0x48, 0x59, 0x73], 4); // pHYs
  put32(chunk, 8, ppm);
  put32(chunk, 12, ppm);
  chunk[16] = 1;
  put32(chunk, 17, crc32(chunk, 4, 17));
  const chunks = pngChunks(src);
  const old = chunks.find((k) => k.type === 'pHYs');
  const at = old ? old.start : (chunks.find((k) => k.type === 'IDAT') ?? chunks[chunks.length - 1]).start;
  const skip = old ? 12 + old.len : 0;
  const out = new Uint8Array(src.length - skip + chunk.length);
  out.set(src.subarray(0, at), 0);
  out.set(chunk, at);
  out.set(src.subarray(at + skip), at + chunk.length);
  return out;
}

// ---------- public ----------

export function readDpi(b: Uint8Array): DpiInfo | null {
  const f = detectFormat(b);
  return f === 'jpeg' ? readJpeg(b) : f === 'png' ? readPng(b) : null;
}

/** A copy of the file with every resolution field set to `dpi` (1–65535). Pixels are not touched. */
export function setDpi(b: Uint8Array, dpi: number): Uint8Array {
  const v = Math.max(1, Math.min(65535, Math.round(dpi)));
  const f = detectFormat(b);
  if (f === 'jpeg') return writeJpeg(b, v);
  if (f === 'png') return writePng(b, v);
  throw new Error('unsupported');
}

/** Pixel dimensions from the header (no decoding). */
export function pixelSize(b: Uint8Array): { width: number; height: number } | null {
  const f = detectFormat(b);
  if (f === 'png') return { width: be32(b, 16), height: be32(b, 20) };
  if (f === 'jpeg')
    for (const s of jpegSegments(b))
      if (s.marker >= 0xc0 && s.marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(s.marker)) return { width: be16(b, s.data + 3), height: be16(b, s.data + 1) };
  return null;
}

/** Print size in inches and centimetres at a resolution. */
export const printSize = (px: number, dpi: number) => ({ in: px / dpi, cm: (px / dpi) * 2.54 });
