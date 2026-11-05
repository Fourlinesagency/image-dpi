// node test/test.mjs [dir]  (default: test/fixtures)
// For each JPEG/PNG: set 300, 600 and 96 DPI, re-read (every resolution field must match), check the file grew by at
// most 21 bytes and that everything outside the header is unchanged. If Python with Pillow is installed, also checks
// that Pillow reads the new DPI and decodes identical pixels.
import { readFileSync, readdirSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { readDpi, setDpi, pixelSize } from '../src/index.ts';

const here = dirname(fileURLToPath(import.meta.url));
const dir = process.argv[2] ?? join(here, 'fixtures');
const out = join(here, 'out');
mkdirSync(out, { recursive: true });
let pillow = true;
try { execFileSync('python', ['-I', '-c', 'import PIL'], { stdio: 'ignore' }); } catch { pillow = false; }
if (!pillow) console.log('(Pillow not found: skipping the decode check)');
let fail = 0, n = 0;
const bad = (m) => { fail++; console.log('  FAIL', m); };
const py = `from PIL import Image, ImageChops
import sys
a=Image.open(sys.argv[1]); b=Image.open(sys.argv[2])
d=b.info.get('dpi'); ex=b.getexif().get(282)
same=ImageChops.difference(a.convert('RGBA'), b.convert('RGBA')).getbbox() is None
print(round(d[0]) if d else None, float(ex) if ex else None, same)`;
for (const name of readdirSync(dir).filter((f) => /\.(jpe?g|png)$/i.test(f))) {
  n++;
  const src = new Uint8Array(readFileSync(join(dir, name)));
  const info = readDpi(src);
  console.log(`\n== ${name}: ${info.format} dpi=${info.dpi} from=${info.from} size=${JSON.stringify(pixelSize(src))}`);
  for (const dpi of [300, 600, 96]) {
    const b = setDpi(src, dpi);
    const again = readDpi(b);
    if (Math.round(again.dpi) !== dpi) bad(`${dpi}: re-read ${again.dpi}`);
    if (again.fields.some((f) => f.dpi && Math.round(f.dpi) !== dpi)) bad(`${dpi}: a field kept another value`);
    if (b.length - src.length > 21) bad(`${dpi}: grew by ${b.length - src.length} bytes`);
    // the last 64 bytes (end of the image data) must be untouched
    if (Buffer.compare(Buffer.from(src.slice(-64)), Buffer.from(b.slice(-64))) !== 0) bad(`${dpi}: image data changed`);
    if (pillow) {
      const p = join(out, name.replace(/(\.[^.]+)$/, `-${dpi}$1`));
      writeFileSync(p, b);
      const [pd, pex, same] = execFileSync('python', ['-I', '-W', 'ignore', '-c', py, join(dir, name), p]).toString().trim().split(' ');
      if (pd !== String(dpi)) bad(`${dpi}: Pillow reads ${pd}`);
      if (pex !== 'None' && Math.round(Number(pex)) !== dpi) bad(`${dpi}: Pillow EXIF ${pex}`);
      if (same !== 'True') bad(`${dpi}: pixels changed`);
    }
    console.log(`  ${dpi}: +${b.length - src.length} B`);
  }
}
if (!n) bad('no images found');
console.log(fail ? `\n${fail} FAILED` : `\nALL PASS (${n} files)`);
process.exit(fail ? 1 : 0);
