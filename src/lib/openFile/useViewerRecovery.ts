import { useEffect, useRef } from "react";
import { migrateLegacyViewerDrafts } from "../notepad/persistence/draftMigration";
import { loadSessionFromDisk } from "../notepad/persistence/sessionManager";
import { notepadBackupList, notepadBackupRead } from "../notepad/ipc";
import { useNotepadPreferences } from "../../stores/notepadPreferences";
import { useNotepadStore } from "../../stores/notepadStore";
import { useAppStore } from "../../stores/appStore";
import { useWorkspacePlatformStore } from "../../stores/workspacePlatformStore";
import { useDocumentStore } from "../../stores/documentStore";
import { supportsFileViewer } from "./classifyFile";
import type { Tab } from "../../types";

export const VIEWER_TABS_KEY = "taomni.viewer.tabs.v1";
interface Snapshot { tabs: Tab[]; activeTabId: string | null }
const restored = new WeakSet<Document>();
function read(): Snapshot {
  try {
    const value = JSON.parse(localStorage.getItem(VIEWER_TABS_KEY) ?? "{}");
    const ids = new Set<string>();
    const tabs = (Array.isArray(value.tabs) ? value.tabs as Tab[] : []).filter((tab) => {
      if (!tab || tab.type !== "file-viewer" || typeof tab.id !== "string" || ids.has(tab.id)
        || typeof tab.title !== "string" || !tab.fileViewer || typeof tab.fileViewer.path !== "string"
        || !supportsFileViewer(tab.fileViewer.kind) || tab.fileViewer.source && tab.fileViewer.source !== "local") return false;
      ids.add(tab.id); return true;
    });
    return { tabs, activeTabId: typeof value.activeTabId === "string" ? value.activeTabId : null };
  } catch { return { tabs: [], activeTabId: null }; }
}

/** Durable local tab metadata is separate from bounded document drafts. Remote
 * copies, protocol tokens, clipboard bytes and temporary paths never recover. */
export function useViewerRecovery(): void {
  // Capture before sibling recovery effects run: Explorer may restore its own
  // fallback first, but a recorded foreground viewer must still win startup.
  const startup = useRef(useAppStore.getState());
  useEffect(() => {
    if (!restored.has(document)) {
      restored.add(document);
      void migrateLegacyViewerDrafts().then(async () => {
        if (!useNotepadPreferences.getState().restoreSessionOnStartup) return;
        try {
          const backups = await notepadBackupList();
          const { openUntitledNotepadDocument } = await import("./index");
          for (const entry of backups) {
            if (entry.docId.startsWith("untitled:") && !useDocumentStore.getState().documents[entry.docId]) {
              const loaded = await notepadBackupRead(entry.id);
              openUntitledNotepadDocument({
                host: "explorer",
                docId: entry.docId,
                title: loaded.entry.name,
                content: loaded.content,
                encoding: loaded.entry.encoding,
                bom: loaded.entry.bom,
                eol: loaded.entry.eol === "CRLF" || loaded.entry.eol === "CR" ? loaded.entry.eol : "LF",
                dirty: true,
              });
              useDocumentStore.getState().applyRestoredBackup(entry.docId, {
                content: loaded.content,
                encoding: loaded.entry.encoding,
                bom: loaded.entry.bom,
                eol: loaded.entry.eol === "CRLF" || loaded.entry.eol === "CR" ? loaded.entry.eol : "LF",
                savedHash: "",
              });
              useNotepadStore.getState().patchDoc(entry.docId, { backupState: "saved" });
            }
          }
          const session = await loadSessionFromDisk(null).catch(() => null);
          if (session?.tabs.length) {
            const { openFile } = await import("./index");
            for (const tab of session.tabs) {
              if (!tab.untitled && tab.path && !useDocumentStore.getState().documents[tab.docKey]) {
                await openFile({ path: tab.path }, { context: "global", host: "explorer" }).catch(() => undefined);
              }
            }
          }
        } catch {
          // Non-fatal startup recovery failure
        }
      });
      const snapshot = read();
      const app = useAppStore.getState();
      const ids = new Set(app.tabs.map((tab) => tab.id));
      if (!app.tabs.some((tab) => tab.type === "file-viewer")) {
        const tabs = [...app.tabs, ...snapshot.tabs.filter((tab) => !ids.has(tab.id))];
        useAppStore.setState({ tabs });
        if (startup.current.activeSideTab === "home" && startup.current.tabs.every((tab) => tab.type === "welcome") && tabs.some((tab) => tab.id === snapshot.activeTabId)) {
          useAppStore.setState({ activeTabId: snapshot.activeTabId, activeSideTab: "sessions" });
        }
      }
    }
    let observed = localStorage.getItem(VIEWER_TABS_KEY);
    let replaced = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const flush = () => {
      if (timer) clearTimeout(timer);
      timer = undefined;
      try {
        if (replaced || localStorage.getItem(VIEWER_TABS_KEY) !== observed) { replaced = true; return; }
        const state = useAppStore.getState();
        const tabs = state.tabs.filter((tab) => tab.type === "file-viewer" && tab.fileViewer && (!tab.fileViewer.source || tab.fileViewer.source === "local"));
        const activeTabId = ["sessions", "tools"].includes(state.activeSideTab) && tabs.some((tab) => tab.id === state.activeTabId) ? state.activeTabId : null;
        const serialized = JSON.stringify({ tabs, activeTabId });
        localStorage.setItem(VIEWER_TABS_KEY, serialized); observed = serialized;
        useDocumentStore.getState().flushDrafts();
      } catch { /* Document store exposes draft-storage failures in its banner. */ }
    };
    const schedule = () => { if (!timer) timer = setTimeout(flush, 150); };
    const unsubscribe = useAppStore.subscribe((state, previous) => { if (state.tabs !== previous.tabs || state.activeTabId !== previous.activeTabId || state.activeSideTab !== previous.activeSideTab) schedule(); });
    const unsubscribeWorkspace = useWorkspacePlatformStore.subscribe(schedule);
    const beforeUnload = (event: BeforeUnloadEvent) => {
      flush();
      const store = useDocumentStore.getState();
      if (Object.keys(store.moduleDrafts ?? {}).length || Object.values(store.documents).some((document) => document.dirty)) {
        event.preventDefault();
        event.returnValue = "";
      }
    };
    flush();
    window.addEventListener("pagehide", flush);
    window.addEventListener("beforeunload", beforeUnload);
    return () => { unsubscribe(); unsubscribeWorkspace(); window.removeEventListener("pagehide", flush); window.removeEventListener("beforeunload", beforeUnload); flush(); };
  }, []);
}
