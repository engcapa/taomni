// Renders an otpauth link as QR modules for an inline <svg> (no innerHTML).
// The `qr` encoder is loaded on demand, like the decoder in qrImage.ts.

/** Light modules around the code; four is the QR quiet-zone minimum. */
export const QR_BORDER = 4;

export interface QrSvgModel {
  /** Width and height in modules, quiet zone included. */
  size: number;
  /** One `M x y h… v1 h… z` rectangle per run of dark modules. */
  path: string;
}

/** SVG path covering every dark module, merged into horizontal runs. */
export function modulesToPath(modules: boolean[][]): string {
  const parts: string[] = [];
  modules.forEach((row, y) => {
    let x = 0;
    while (x < row.length) {
      if (!row[x]) {
        x += 1;
        continue;
      }
      const start = x;
      while (x < row.length && row[x]) x += 1;
      parts.push(`M${start} ${y}h${x - start}v1h-${x - start}z`);
    }
  });
  return parts.join("");
}

export async function qrSvgModel(text: string): Promise<QrSvgModel> {
  const { default: encodeQR } = await import("qr");
  const modules = encodeQR(text, "raw", { border: QR_BORDER });
  return { size: modules.length, path: modulesToPath(modules) };
}
