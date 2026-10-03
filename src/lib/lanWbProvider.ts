// lanWbProvider.ts — Yjs sync provider over the LanChat P2P channel (task 04).
//
// The backend relays whiteboard frames untouched; this provider carries Yjs
// document updates (base64 in wb-op / wb-snapshot) and cursor positions
// (wb-cursor) between board participants. New joiners pull a full snapshot via
// wb-snapshot-req. Elements merge through Yjs CRDT semantics.

import * as Y from "yjs";

import { lanchatSendSignal } from "./ipc";
import { isTauriRuntime } from "./runtime";

function bytesToB64(bytes: Uint8Array): string {
  let bin = "";
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin);
}
function b64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export interface LanWbCallbacks {
  onCursor: (nodeId: string, x: number, y: number, name: string, color: string) => void;
  onPeerLeave: (nodeId: string) => void;
}

export class LanWbProvider {
  readonly boardId: string;
  private doc: Y.Doc;
  private myId: string;
  private participants = new Set<string>();
  private cb: LanWbCallbacks;
  private updateHandler: (update: Uint8Array, origin: unknown) => void;

  /** Networked only in the desktop runtime; in browser preview the board is
   *  local-only (draw without sync). */
  private send(peer: string, type: string, payload: Record<string, unknown>) {
    if (!isTauriRuntime()) return;
    void lanchatSendSignal(peer, type, payload).catch(() => undefined);
  }

  constructor(boardId: string, doc: Y.Doc, myId: string, participants: string[], cb: LanWbCallbacks) {
    this.boardId = boardId;
    this.doc = doc;
    this.myId = myId;
    this.cb = cb;
    participants.forEach((p) => this.participants.add(p));

    this.updateHandler = (update, origin) => {
      if (origin === this) return; // applied from a remote frame — don't echo
      const b64 = bytesToB64(update);
      for (const peer of this.participants) {
        this.send(peer, "wb-op", { boardId: this.boardId, update: b64 });
      }
    };
    doc.on("update", this.updateHandler);
  }

  addParticipant(peerId: string) {
    if (peerId === this.myId) return;
    this.participants.add(peerId);
    // Send the newcomer the full current state.
    const state = bytesToB64(Y.encodeStateAsUpdate(this.doc));
    this.send(peerId, "wb-snapshot", { boardId: this.boardId, state });
  }

  removeParticipant(peerId: string) {
    this.participants.delete(peerId);
    this.cb.onPeerLeave(peerId);
  }

  /** Request a full snapshot from a peer (used when joining a board). */
  requestSnapshot(fromPeer: string) {
    this.send(fromPeer, "wb-snapshot-req", { boardId: this.boardId });
  }

  /** Broadcast the local cursor position (throttle at the call site). */
  sendCursor(x: number, y: number, name: string, color: string) {
    for (const peer of this.participants) {
      this.send(peer, "wb-cursor", { boardId: this.boardId, x, y, name, color });
    }
  }

  /** Feed an inbound whiteboard frame (from the lanchat://wb event). */
  handleFrame(from: string, type: string, payload: Record<string, unknown>) {
    if (payload.boardId && payload.boardId !== this.boardId) return;
    switch (type) {
      case "wb-op":
        if (typeof payload.update === "string") {
          Y.applyUpdate(this.doc, b64ToBytes(payload.update), this);
        }
        break;
      case "wb-snapshot":
        if (typeof payload.state === "string") {
          Y.applyUpdate(this.doc, b64ToBytes(payload.state), this);
        }
        break;
      case "wb-snapshot-req": {
        const state = bytesToB64(Y.encodeStateAsUpdate(this.doc));
        this.send(from, "wb-snapshot", { boardId: this.boardId, state });
        break;
      }
      case "wb-cursor":
        this.cb.onCursor(
          from,
          Number(payload.x) || 0,
          Number(payload.y) || 0,
          String(payload.name ?? from.slice(0, 4)),
          String(payload.color ?? "#3b82f6"),
        );
        break;
      case "wb-join":
        this.addParticipant(from);
        break;
      case "wb-leave":
        this.removeParticipant(from);
        break;
      default:
        break;
    }
  }

  destroy() {
    this.doc.off("update", this.updateHandler);
    this.participants.clear();
  }
}
