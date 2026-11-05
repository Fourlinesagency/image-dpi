export type DpiFormat = 'jpeg' | 'png';
export type DpiSource = 'photoshop' | 'exif' | 'jfif' | 'png';
export type DpiInfo = {
    format: DpiFormat;
    /** Resolution the file states, or null when it has none (apps then assume 72 or 96). */
    dpi: number | null;
    /** Where that value came from (the field most apps read first). */
    from: DpiSource | null;
    /** Every place the file stores a resolution, for the report. */
    fields: {
        where: DpiSource;
        dpi: number | null;
    }[];
};
export declare function detectFormat(b: Uint8Array): DpiFormat | null;
export declare function readDpi(b: Uint8Array): DpiInfo | null;
/** A copy of the file with every resolution field set to `dpi` (1–65535). Pixels are not touched. */
export declare function setDpi(b: Uint8Array, dpi: number): Uint8Array;
/** Pixel dimensions from the header (no decoding). */
export declare function pixelSize(b: Uint8Array): {
    width: number;
    height: number;
} | null;
/** Print size in inches and centimetres at a resolution. */
export declare const printSize: (px: number, dpi: number) => {
    in: number;
    cm: number;
};
