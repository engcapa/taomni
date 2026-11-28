import { MAX_PROJECT_BYTES } from "./projectXml.js";

const CHUNK_BYTES = 768 * 1024;

function encodeBlock(bytes) {
  const parts = [];
  for (let index = 0; index < bytes.length; index += 8192) {
    parts.push(String.fromCharCode(...bytes.subarray(index, index + 8192)));
  }
  return btoa(parts.join(""));
}

export async function readProject(api, source, signal) {
  const file = await source.read();
  signal.throwIfAborted();
  if (file.size > MAX_PROJECT_BYTES) throw new Error("Project preview is limited to 8 MiB.");
  if (!["mpp", "mpx"].includes(source.extension)) return new Uint8Array(await file.arrayBuffer());

  const id = crypto.randomUUID();
  const options = { signal };
  const release = api.deferCleanup?.("project/close", { id });
  try {
    await api.invoke("project/begin", { id, size: file.size }, options);
    for (let offset = 0; offset < file.size; offset += CHUNK_BYTES) {
      const block = new Uint8Array(await file.slice(offset, offset + CHUNK_BYTES).arrayBuffer());
      signal.throwIfAborted();
      await api.invoke("project/append", { id, offset, data: encodeBlock(block) }, options);
    }
    const { size } = await api.invoke("project/convert", { id }, options);
    if (!Number.isSafeInteger(size) || size < 1 || size > MAX_PROJECT_BYTES) {
      throw new Error("The converted Project file has an invalid size.");
    }
    const xml = new Uint8Array(size);
    for (let offset = 0; offset < size; offset += CHUNK_BYTES) {
      const { data } = await api.invoke("project/read", { id, offset }, options);
      const block = atob(data);
      if (block.length !== Math.min(CHUNK_BYTES, size - offset)) {
        throw new Error("The converted Project file is incomplete.");
      }
      for (let index = 0; index < block.length; index++) xml[offset + index] = block.charCodeAt(index);
    }
    signal.throwIfAborted();
    return xml;
  } finally {
    if (release) release();
    else void api.invoke("project/close", { id }).catch(() => {});
  }
}
