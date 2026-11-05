# image-dpi

Read and change the **DPI of JPEG and PNG files without touching the pixels**. Only the resolution fields in the file
header are rewritten. The compressed image data is copied byte for byte, so quality and pixel size never change.

No dependencies. Works in the browser and in Node.

**Try it in your browser:** [prepmypost.com/change-dpi-of-image](https://prepmypost.com/change-dpi-of-image): this
library is the engine behind that page. The image is processed in your browser and isn't uploaded.

## Why

Print shops and online forms often ask for "300 DPI". DPI is only a label in the header: it doesn't change the pixels.
Most tools set it by decoding and re-saving the image, which re-compresses a JPEG and loses quality. This library edits
the label and leaves the image data alone.

## What it edits

| Format | Fields |
|---|---|
| JPEG | JFIF APP0 density, EXIF IFD0 `XResolution` / `YResolution` / `ResolutionUnit`, Photoshop APP13 `ResolutionInfo`. All are edited in place. A JFIF segment is added if the file has none. |
| PNG | the `pHYs` chunk (replaced, or added before the first `IDAT`) |

Every field the file has is set to the new value, so apps that read different fields agree.

## Use

```js
import { readDpi, setDpi, pixelSize, printSize } from 'image-dpi';

const bytes = new Uint8Array(await file.arrayBuffer());
readDpi(bytes);   // { format: 'jpeg', dpi: 72, from: 'jfif', fields: [{ where: 'jfif', dpi: 72 }, …] }
const out = setDpi(bytes, 300);  // a new Uint8Array; the input is not modified
pixelSize(out);   // { width: 3000, height: 2000 } (from the header, no decoding)
printSize(3000, 300);            // { in: 10, cm: 25.4 }
```

`readDpi` returns `dpi: null` when the file states no resolution (apps then assume 72 or 96).
`setDpi` clamps to 1–65535 and throws on anything that isn't a JPEG or PNG.

Install from GitHub (not on npm yet):

```
npm install github:Fourlinesagency/image-dpi
```

## Test

```
npm test   # Node 22.18+
```

For every file in `test/fixtures` (JFIF only, EXIF only, Photoshop, Motorola byte order, PNG with and without `pHYs`),
the test sets 300, 600 and 96 DPI and re-reads every field. It also checks the file grew by at most 21 bytes and the
image data is unchanged. If Python with Pillow is installed, it also checks that Pillow reads the new DPI and decodes
identical pixels.

## Licence

MIT, © 2026 [Fourlines Agency](https://fourlinesagency.com). Made for [PrepMyPost](https://prepmypost.com), free
creator tools that run in your browser.
