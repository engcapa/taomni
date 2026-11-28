const TYPE_WIDTH = new Map([[1, 1], [3, 2], [4, 4], [7, 1], [13, 4]]);
const MAX_ENTRIES = 1024;
const MAX_DIRECTORIES = 48;
const MAX_FIELD_VALUES = 16_384;
const READ_TAGS = new Set([
  0x11, 254, 256, 257, 258, 259, 262, 273, 274, 277, 278, 279, 284, 330, 513, 514, 34665, 37500,
]);

// Classic TIFF confines every offset to the current byte span. Nikon's
// type 2 MakerNote supplies a separate TIFF header with its own byte order.
export function tiffDirectories(bytes) {
  if (bytes.length < 8) return undefined;
  const littleEndian = bytes[0] === 0x49 && bytes[1] === 0x49;
  if (!littleEndian && (bytes[0] !== 0x4d || bytes[1] !== 0x4d)) return undefined;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const u16 = (offset) => view.getUint16(offset, littleEndian);
  const u32 = (offset) => view.getUint32(offset, littleEndian);
  if (u16(2) !== 42) return undefined;
  const inBounds = (start, length) => start >= 0 && start <= bytes.length && length <= bytes.length - start;

  function directory(offset) {
    if (offset < 8 || !inBounds(offset, 2)) return undefined;
    const count = u16(offset);
    if (count > MAX_ENTRIES || !inBounds(offset, 2 + count * 12 + 4)) return undefined;
    const fields = new Map();
    for (let index = 0; index < count; index++) {
      const entry = offset + 2 + index * 12;
      const tag = u16(entry);
      if (!READ_TAGS.has(tag)) continue;
      const type = u16(entry + 2);
      const width = TYPE_WIDTH.get(type);
      const count = u32(entry + 4);
      if (!width || !count) continue;
      const length = width * count;
      const start = length <= 4 ? entry + 8 : u32(entry + 8);
      if (inBounds(start, length)) fields.set(tag, { type, width, count, length, start });
    }
    return {
      next: u32(offset + 2 + count * 12),
      bytes(tag) {
        const field = fields.get(tag);
        if (field?.type === 1 || field?.type === 7) return bytes.subarray(field.start, field.start + field.length);
      },
      values(tag, limit = MAX_FIELD_VALUES) {
        const field = fields.get(tag);
        if (!field || field.type === 7 || field.count > limit) return [];
        const readValue = field.width === 1 ? (offset) => bytes[offset] : field.width === 2 ? u16 : u32;
        return Array.from({ length: field.count }, (_, index) => readValue(field.start + index * field.width));
      },
      first(tag) {
        return this.values(tag, 1)[0];
      },
    };
  }

  const root = directory(u32(4));
  if (!root) return undefined;
  return {
    root,
    directory,
    range(start, length) {
      if (start > 0 && length > 0 && inBounds(start, length)) return bytes.subarray(start, start + length);
    },
    *images() {
      const pending = [root];
      const visited = new Set([u32(4)]);
      while (pending.length) {
        const current = pending.shift();
        yield current;
        for (const offset of [current.next, ...current.values(330, MAX_DIRECTORIES)]) {
          if (!offset || visited.size >= MAX_DIRECTORIES || visited.has(offset)) continue;
          visited.add(offset);
          const image = directory(offset);
          if (image) pending.push(image);
        }
      }
    },
  };
}

export function nikonJpeg(tiff) {
  const exifOffset = tiff.root.first(34665);
  const note = tiff.directory(exifOffset ?? 0)?.bytes(37500);
  if (!note || note.length < 18 || ![0x4e, 0x69, 0x6b, 0x6f, 0x6e, 0, 2].every((value, index) => note[index] === value)) {
    return undefined;
  }
  const nikon = tiffDirectories(note.subarray(10));
  const preview = nikon?.directory(nikon.root.first(0x11) ?? 0);
  return preview && nikon.range(preview.first(513), preview.first(514));
}
