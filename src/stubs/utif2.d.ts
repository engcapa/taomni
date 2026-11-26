declare module "utif2" {
  interface Directory { t256?: number[]; t257?: number[]; width?: number; height?: number }
  export function decode(buffer: ArrayBuffer): Directory[];
  export function decodeImage(buffer: ArrayBuffer, directory: Directory): void;
  export function toRGBA8(directory: Directory): Uint8Array;
}
