const FIXTURE_KEY = "taomni.preview.taoffice-project.import.v1";
const CHUNK_BYTES = 768 * 1024;
const MAX_BYTES = 8 * 1024 * 1024;

interface Transfer {
  bytes: Uint8Array<ArrayBuffer>;
  offset: number;
  result?: Uint8Array;
}

const transfers = new Map<string, Transfer>();

export async function invokeProjectPreview(command: string, payload: unknown): Promise<unknown> {
  const { id, size, offset, data } = payload as { id: string; size: number; offset: number; data: string };
  if (command === "project/close") {
    transfers.delete(id);
    return null;
  }
  if (command === "project/begin") {
    if (!Number.isSafeInteger(size) || size <= 0 || size > MAX_BYTES || transfers.has(id)) {
      throw new Error("Invalid Project import size or ID");
    }
    transfers.set(id, { bytes: new Uint8Array(size), offset: 0 });
    return null;
  }
  const transfer = transfers.get(id);
  if (!transfer) throw new Error("Project import expired");
  if (command === "project/append") {
    const block = atob(data);
    if (offset !== transfer.offset || !block.length || block.length > CHUNK_BYTES ||
      offset + block.length > transfer.bytes.length) {
      throw new Error("Invalid Project transfer block");
    }
    transfer.bytes.set(Uint8Array.from(block, (value) => value.charCodeAt(0)), offset);
    transfer.offset += block.length;
    return null;
  }
  if (command === "project/convert") {
    const fixture = JSON.parse(localStorage.getItem(FIXTURE_KEY) ?? "null") as { hash: string; xml: string } | null;
    const digest = await crypto.subtle.digest("SHA-256", transfer.bytes);
    const hash = Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
    if (!fixture || fixture.hash !== hash || transfers.get(id) !== transfer || transfer.offset !== transfer.bytes.length) {
      throw new Error("The browser fixture could not import this Project file");
    }
    transfer.result = new TextEncoder().encode(fixture.xml);
    return { size: transfer.result.length };
  }
  if (command === "project/read" && transfer.result && offset >= 0 && offset < transfer.result.length) {
    const block = transfer.result.subarray(offset, offset + CHUNK_BYTES);
    return { data: btoa(Array.from(block, (byte) => String.fromCharCode(byte)).join("")) };
  }
  throw new Error("Project command is unavailable");
}
