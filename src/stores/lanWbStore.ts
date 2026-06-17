import { create } from "zustand";
import * as Y from "yjs";

import { lanchatSendSignal, lanchatSignalGroup, listenLanChatWb } from "../lib/ipc";
import { LanWbProvider, type LanWbCallbacks } from "../lib/lanWbProvider";
import { isTauriRuntime } from "../lib/runtime";
import { useLanChatStore } from "./lanChatStore";

export type WbTool = "select" | "pen" | "rect" | "ellipse" | "arrow" | "text" | "note" | "eraser";

/** A whiteboard element. Stored as a plain object value in a Y.Map keyed by id
 *  (per-key last-writer-wins); `seq` gives a stable draw order. */
export interface WbElement {
  id: string;
  type: "pen" | "rect" | "ellipse" | "arrow" | "text" | "note";
  seq: number;
  color: string;
  strokeWidth: number;
  /** pen: flat [x,y,x,y,...]. */
  points?: number[];
  x?: number;
  y?: number;
  w?: number;
  h?: number;
  x2?: number;
  y2?: number;
  text?: string;
}

/** An incoming whiteboard invite. */
interface WbInvite {
  boardId: string;
  from: string;
  fromName: string;
  name: string;
  convId: string;
}

interface WbStore {
  boardId: string | null;
  name: string;
  /** Conversation that owns the board (direct:<peer> or group:<id>). */
  convId: string | null;
  active: boolean;
  elements: WbElement[];
  tool: WbTool;
  color: string;
  strokeWidth: number;
  /** Remote cursors keyed by node id: position + label/color. */
  cursors: Record<string, { x: number; y: number; name: string; color: string }>;
  incoming: WbInvite | null;

  // local model handles (not React state)
  doc: Y.Doc | null;
  provider: LanWbProvider | null;
  undoMgr: Y.UndoManager | null;

  setTool: (t: WbTool) => void;
  setColor: (c: string) => void;
  setStrokeWidth: (w: number) => void;

  /** Subscribe to lanchat://wb (once per window). */
  init: () => Promise<void>;
  /** Open a new shared board for a conversation and invite its participants. */
  startBoard: (convId: string, name: string) => void;
  /** Join a board we were invited to. */
  joinBoard: () => void;

  /** Create a fresh local board document (no networking yet). */
  initLocalBoard: (boardId: string, name: string, convId: string | null) => void;
  addElement: (el: WbElement) => void;
  updateElement: (id: string, patch: Partial<WbElement>) => void;
  deleteElement: (id: string) => void;
  clear: () => void;
  undo: () => void;
  redo: () => void;
  closeBoard: () => void;

  // set by the provider layer (phase 3)
  setCursor: (nodeId: string, x: number, y: number, name: string, color: string) => void;
  removeCursor: (nodeId: string) => void;
  setIncoming: (inv: WbInvite | null) => void;
}

let seqCounter = 0;
export function nextSeq(): number {
  seqCounter = Math.max(seqCounter + 1, Date.now());
  return seqCounter;
}

let wbUnsub: (() => void) | null = null;
let providerCb: LanWbCallbacks = { onCursor: () => {}, onPeerLeave: () => {} };

function myNodeId(): string {
  return useLanChatStore.getState().profile?.id ?? "";
}
function peerName(id: string): string {
  return useLanChatStore.getState().roster.find((p) => p.id === id)?.name ?? id.slice(0, 6);
}
function participantsOf(convId: string, myId: string): string[] {
  if (convId.startsWith("direct:")) return [convId.slice("direct:".length)];
  if (convId.startsWith("group:")) {
    const gid = convId.slice("group:".length);
    const g = useLanChatStore.getState().groups.find((x) => x.id === gid);
    return (g?.members ?? []).filter((m) => m !== myId);
  }
  return [];
}

function elementsMap(doc: Y.Doc): Y.Map<WbElement> {
  return doc.getMap<WbElement>("elements");
}

function snapshot(doc: Y.Doc): WbElement[] {
  return Array.from(elementsMap(doc).values()).sort((a, b) => a.seq - b.seq);
}

export const useLanWbStore = create<WbStore>((set, get) => ({
  boardId: null,
  name: "协作白板",
  convId: null,
  active: false,
  elements: [],
  tool: "pen",
  color: "#1e40af",
  strokeWidth: 3,
  cursors: {},
  incoming: null,
  doc: null,
  provider: null,
  undoMgr: null,

  setTool: (t) => set({ tool: t }),
  setColor: (c) => set({ color: c }),
  setStrokeWidth: (w) => set({ strokeWidth: w }),

  initLocalBoard: (boardId, name, convId) => {
    get().doc?.destroy();
    const doc = new Y.Doc();
    const map = elementsMap(doc);
    const undoMgr = new Y.UndoManager(map);
    map.observeDeep(() => set({ elements: snapshot(doc) }));
    set({ boardId, name, convId, active: true, doc, undoMgr, elements: [], cursors: {} });
  },

  addElement: (el) => {
    const doc = get().doc;
    if (!doc) return;
    elementsMap(doc).set(el.id, el);
  },

  updateElement: (id, patch) => {
    const doc = get().doc;
    if (!doc) return;
    const map = elementsMap(doc);
    const cur = map.get(id);
    if (cur) map.set(id, { ...cur, ...patch });
  },

  deleteElement: (id) => {
    const doc = get().doc;
    if (doc) elementsMap(doc).delete(id);
  },

  clear: () => {
    const doc = get().doc;
    if (doc) elementsMap(doc).clear();
  },

  undo: () => get().undoMgr?.undo(),
  redo: () => get().undoMgr?.redo(),

  init: async () => {
    if (wbUnsub || !isTauriRuntime()) return;
    const cursorCb = {
      onCursor: (id: string, x: number, y: number, name: string, color: string) => get().setCursor(id, x, y, name, color),
      onPeerLeave: (id: string) => get().removeCursor(id),
    };
    // stash the callbacks so start/join can build providers
    providerCb = cursorCb;
    try {
      wbUnsub = await listenLanChatWb((sig) => {
        const { from, type, payload } = sig as { from: string; type: string; payload: Record<string, unknown> };
        const s = get();
        if (type === "wb-invite") {
          if (!s.active) {
            s.setIncoming({
              boardId: String(payload.boardId),
              from,
              fromName: peerName(from),
              name: String(payload.name ?? "协作白板"),
              convId: String(payload.convId ?? ""),
            });
          }
          return;
        }
        if (type === "wb-join") {
          if (s.active && s.boardId === payload.boardId) s.provider?.addParticipant(from);
          return;
        }
        s.provider?.handleFrame(from, type, payload);
      });
    } catch (e) {
      console.debug("lanWb init:", e);
    }
  },

  startBoard: (convId, name) => {
    const myId = myNodeId();
    const boardId = crypto.randomUUID();
    get().initLocalBoard(boardId, name, convId);
    const doc = get().doc;
    if (!doc) return;
    const parts = participantsOf(convId, myId);
    const provider = new LanWbProvider(boardId, doc, myId, parts, providerCb);
    set({ provider });
    const payload = { boardId, name, convId };
    if (isTauriRuntime()) {
      if (convId.startsWith("group:")) void lanchatSignalGroup(convId.slice("group:".length), "wb-invite", payload).catch(() => undefined);
      else if (convId.startsWith("direct:")) void lanchatSendSignal(convId.slice("direct:".length), "wb-invite", payload).catch(() => undefined);
    }
  },

  joinBoard: () => {
    const inv = get().incoming;
    if (!inv) return;
    const myId = myNodeId();
    get().initLocalBoard(inv.boardId, inv.name, inv.convId);
    const doc = get().doc;
    if (!doc) return;
    const parts = participantsOf(inv.convId, myId);
    if (!parts.includes(inv.from)) parts.push(inv.from);
    const provider = new LanWbProvider(inv.boardId, doc, myId, parts, providerCb);
    set({ provider, incoming: null });
    provider.requestSnapshot(inv.from);
    if (isTauriRuntime()) {
      for (const p of parts) void lanchatSendSignal(p, "wb-join", { boardId: inv.boardId }).catch(() => undefined);
    }
  },

  closeBoard: () => {
    const s = get();
    if (s.boardId && s.convId) {
      const myId = myNodeId();
      if (isTauriRuntime()) {
        for (const p of participantsOf(s.convId, myId)) {
          void lanchatSendSignal(p, "wb-leave", { boardId: s.boardId }).catch(() => undefined);
        }
      }
    }
    s.provider?.destroy();
    s.doc?.destroy();
    set({ boardId: null, active: false, doc: null, provider: null, undoMgr: null, elements: [], cursors: {}, convId: null });
  },

  setCursor: (nodeId, x, y, name, color) =>
    set((s) => ({ cursors: { ...s.cursors, [nodeId]: { x, y, name, color } } })),
  removeCursor: (nodeId) =>
    set((s) => {
      const cursors = { ...s.cursors };
      delete cursors[nodeId];
      return { cursors };
    }),
  setIncoming: (inv) => set({ incoming: inv }),
}));
