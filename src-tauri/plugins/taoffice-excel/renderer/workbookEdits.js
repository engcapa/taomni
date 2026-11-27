const TRANSFER_BYTES = 768 * 1024;
const MAX_COPY_BYTES = 24 * 1024 * 1024;
export const MAX_EDITS = 128;
export const numericCell = /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?$/i;

export function excelEditKey(sheet, address) {
  return sheet + "\u0000" + address;
}

export function changedEdits(edits, saved) {
  if (edits.size !== saved.size) return true;
  for (const [key, edit] of edits) {
    if (saved.get(key)?.value !== edit.value) return true;
  }
  return false;
}

export async function workbookCopyBytes(api, id, edits, signal) {
  const copyId = crypto.randomUUID();
  const release = api.deferCleanup?.("workbook/releaseCopy", { id, copyId });
  try {
    const options = { signal };
    const { size } = await api.invoke("workbook/copy", { id, copyId, edits: [...edits.values()] }, options);
    if (!Number.isSafeInteger(size) || size <= 0 || size > MAX_COPY_BYTES) {
      throw new Error("Invalid workbook copy size");
    }
    const bytes = new Uint8Array(size);
    for (let offset = 0; offset < size; offset += TRANSFER_BYTES) {
      const { data } = await api.invoke("workbook/copyChunk", { id, copyId, offset }, options);
      const block = atob(data);
      if (block.length !== Math.min(TRANSFER_BYTES, size - offset)) {
        throw new Error("Incomplete workbook copy");
      }
      for (let index = 0; index < block.length; index++) bytes[offset + index] = block.charCodeAt(index);
    }
    return bytes;
  } finally {
    if (release) release();
    else void api.invoke("workbook/releaseCopy", { id, copyId }).catch(() => {});
  }
}
