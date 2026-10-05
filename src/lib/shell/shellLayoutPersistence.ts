import { TAB_LANES, type PersistedShellLayoutV2, type ShellRestoreSource, type TabLane, type PanelPreference } from "./types";
import { clampSize } from "./layoutPolicy";
import type { CodeWorkspaceTabInfo } from "../../types";

export const SHELL_LAYOUT_KEY = "taomni.shellLayout.v2";
export interface LayoutStorage { getItem(key: string): string | null; setItem(key: string, value: string): void; removeItem(key: string): void }
const panelKinds = ["sftp", "git", "problems", "workspace-terminal"] as const;
export function defaultShellLayout(): PersistedShellLayoutV2 {
  return {
    version: 2,
    rail: { edge: "left", visible: true },
    navigator: { width: 248, collapsedByLane: { home: false, connect: true, build: true, communicate: false, utility: false }, lastArea: "sessions" },
    panelDefaults: { sftp: { edge: "right", size: 330, pinned: true }, git: { edge: "bottom", size: 280, pinned: true },
      problems: { edge: "bottom", size: 280, pinned: true }, "workspace-terminal": { edge: "bottom", size: 280, pinned: true } },
    panelOverrides: {}, tao: { edge: "right", width: 360, height: 280, pinned: true, opacity: 1 },
    restoreSources: {}, restoredTabs: {}, recentPanels: [],
  };
}
const object = (v: unknown): Record<string, unknown> => v && typeof v === "object" && !Array.isArray(v) ? v as Record<string, unknown> : {};
const number = (v: unknown, fallback: number, min: number, max: number) => typeof v === "number" && Number.isFinite(v) ? clampSize(v, min, max) : fallback;
const bool = (v: unknown, fallback: boolean) => typeof v === "boolean" ? v : fallback;
const string = (v: unknown): string | undefined => typeof v === "string" && v.length > 0 && v.length <= 4096 ? v : undefined;
const businessLane = (v: unknown) => TAB_LANES.find((lane) => lane !== "home" && lane === v) as Exclude<TabLane, "home"> | undefined;
function preference(raw: unknown, fallback: PanelPreference): PanelPreference {
  const p = object(raw), edge = p.edge === "right" || p.edge === "bottom" ? p.edge : fallback.edge;
  return { edge, size: number(p.size, fallback.size, edge === "right" ? 280 : 220, 600), pinned: bool(p.pinned, fallback.pinned) };
}
export function safeWorkspace(raw: unknown): CodeWorkspaceTabInfo | null {
  const w = object(raw);
  if (typeof w.repoRoot !== "string") return null;
  const roots = Array.isArray(w.roots) ? w.roots.flatMap((value) => {
    const r = object(value), id = string(r.id), name = string(r.name), path = string(r.path);
    return id && name && path && (r.kind === "git" || r.kind === "folder") ? [{ id, name, path, kind: r.kind as "git" | "folder" }] : [];
  }).slice(0, 100) : [];
  const looseFiles = Array.isArray(w.looseFiles) ? w.looseFiles.flatMap((value) => {
    const f = object(value), id = string(f.id), name = string(f.name), path = string(f.path);
    return id && name && path ? [{ id, name, path }] : [];
  }).slice(0, 200) : [];
  if (!w.repoRoot && !roots.length && !looseFiles.length) return null;
  const file = object(w.initialFile);
  const initialFile = file.kind === "root" && string(file.rootId) && typeof file.path === "string"
    ? { kind: "root" as const, rootId: String(file.rootId), path: file.path.slice(0, 4096) }
    : file.kind === "loose" && string(file.id) && string(file.path)
      ? { kind: "loose" as const, id: String(file.id), path: String(file.path) } : null;
  return { repoRoot: w.repoRoot.slice(0, 4096), roots, looseFiles,
    ...(string(w.workspaceId) ? { workspaceId: string(w.workspaceId) } : {}),
    ...(string(w.workspaceInstanceId) ? { workspaceInstanceId: string(w.workspaceInstanceId) } : {}),
    ...(string(w.name) ? { name: string(w.name) } : {}),
    ...(string(w.initialPath) ? { initialPath: string(w.initialPath) } : {}), ...(initialFile ? { initialFile } : {}) };
}
export function validateShellLayout(raw: unknown): PersistedShellLayoutV2 | null {
  const value = object(raw);
  if (value.version !== 2) return null;
  const defaults = defaultShellLayout(), nav = object(value.navigator), tao = object(value.tao);
  const collapsed = object(nav.collapsedByLane);
  const restoreSources: Record<string, ShellRestoreSource> = Object.fromEntries(Object.entries(object(value.restoreSources)).slice(0, 200).flatMap(([key, rawSource]) => {
    const s = object(rawSource);
    if (s.kind === "run-entry" && string(s.identity) && key === `run-entry:${s.identity}`)
      return [[key, { kind: "run-entry", identity: s.identity } as ShellRestoreSource]];
    const workspace = s.kind === "workspace" ? safeWorkspace(s.workspace) : null;
    if (workspace && string(s.workspaceInstanceId) && key === `workspace:${s.workspaceInstanceId}`)
      return [[key, { kind: "workspace", workspaceInstanceId: s.workspaceInstanceId, workspace } as ShellRestoreSource]];
    // An unknown future view becomes a safe Utility item; never launch it as a
    // protocol or retain its arbitrary payload/credentials in Shell storage.
    if (string(s.kind) && !["workspace", "run-entry"].includes(String(s.kind)) && string(s.identity) && key === `unsupported:${s.identity}`)
      return [[key, { kind: "unsupported", identity: s.identity, originalKind: string(s.originalKind) ?? s.kind, title: string(s.title) ?? String(s.kind) } as ShellRestoreSource]];
    return [];
  }));
  const restoredTabs = Object.fromEntries(Object.entries(object(value.restoredTabs)).filter(([ref]) => Object.hasOwn(restoreSources, ref)).map(([ref, rawTab]) => {
    const t = object(rawTab), laneOverride = businessLane(t.laneOverride);
    return [ref, { pinned: bool(t.pinned, false), order: number(t.order, 0, 0, 10000), ...(laneOverride ? { laneOverride } : {}) }];
  }));
  const panelDefaults = Object.fromEntries(panelKinds.map((kind) => [kind, preference(object(value.panelDefaults)[kind], defaults.panelDefaults[kind])])) as PersistedShellLayoutV2["panelDefaults"];
  const panelOverrides = Object.fromEntries(Object.entries(object(value.panelOverrides)).slice(0, 400).flatMap(([key, v]) => {
    const kind = panelKinds.find((k) => key.endsWith(`:${k}`));
    const ref = kind ? key.slice(0, -(kind.length + 1)) : "";
    return kind && Object.hasOwn(restoreSources, ref) ? [[key, preference(v, panelDefaults[kind])]] : [];
  }));
  const seenPanels = new Set<string>();
  const recentPanels: PersistedShellLayoutV2["recentPanels"] = Array.isArray(value.recentPanels) ? value.recentPanels.flatMap((rawPanel) => {
    const p = object(rawPanel), kind = panelKinds.find((k) => k === p.kind), ref = string(p.restoreRef);
    return kind && ref ? [{ kind, restoreRef: ref, preferredPlacement: (p.preferredPlacement === "detached" ? "detached" : "dock") as "dock" | "detached", lastUsedAt: number(p.lastUsedAt, 0, 0, Number.MAX_SAFE_INTEGER) }] : [];
  }).sort((a, b) => b.lastUsedAt - a.lastUsedAt).filter((panel) => {
    const key = `${panel.restoreRef}:${panel.kind}`;
    if (seenPanels.has(key)) return false;
    seenPanels.add(key); return true;
  }).slice(0, 20) : [];
  const lastActiveRestoreRef = string(value.lastActiveRestoreRef);
  const rail = object(value.rail);
  return { version: 2, rail: { edge: ["left", "right", "top", "bottom"].includes(String(rail.edge)) ? rail.edge as PersistedShellLayoutV2["rail"]["edge"] : "left", visible: bool(rail.visible, true) }, navigator: { width: number(nav.width, 248, 200, 400),
    collapsedByLane: Object.fromEntries(TAB_LANES.map((lane) => [lane, bool(collapsed[lane], defaults.navigator.collapsedByLane[lane])])) as Record<TabLane, boolean>,
    lastArea: nav.lastArea === "home" || nav.lastArea === "workspaces" ? nav.lastArea : "sessions" },
    panelDefaults, panelOverrides, restoreSources, restoredTabs, recentPanels,
    ...(lastActiveRestoreRef && Object.hasOwn(restoreSources, lastActiveRestoreRef) ? { lastActiveRestoreRef } : {}),
    tao: { edge: ["left", "right", "top", "bottom"].includes(String(tao.edge)) ? tao.edge as PersistedShellLayoutV2["tao"]["edge"] : "right",
      width: number(tao.width, 360, 300, 600), height: number(tao.height, 280, 220, 600), pinned: bool(tao.pinned, true),
      opacity: number(tao.opacity, 1, .65, 1) } };
}
export function loadShellLayout(storage: LayoutStorage, viewportWidth: number): { layout: PersistedShellLayoutV2; warning: string | null; writable: boolean } {
  const defaults = defaultShellLayout();
  try {
    const raw = storage.getItem(SHELL_LAYOUT_KEY);
    if (raw) {
      let parsed: unknown;
      try { parsed = JSON.parse(raw); } catch { return { layout: defaults, warning: "invalid", writable: false }; }
      const layout = validateShellLayout(parsed);
      return layout ? { layout, warning: null, writable: true } : { layout: defaults, warning: "version", writable: false };
    }
    const parseLegacy = (key: string) => { try { return object(JSON.parse(storage.getItem(key) ?? "{}")); } catch { return {}; } };
    const other = storage.getItem("taomni.sidebarCollapsed") === "true";
    const groups = parseLegacy("taomni.sidebarCollapsedByGroup.v1");
    defaults.navigator.collapsedByLane = { home: other, communicate: other, utility: other,
      connect: bool(groups.terminal, true), build: bool(groups["code-workspace"], true) };
    const panels = parseLegacy("taomni.resizable-panels.v4.main-layout");
    if (typeof panels.sidebar === "number" && panels.sidebar > 0)
      defaults.navigator.width = number(panels.sidebar * Math.max(0, viewportWidth - 52) / 100, 248, 200, 400);
    const oldTao = parseLegacy("taomni.chatDrawer.layout.v1");
    defaults.tao = validateShellLayout({ ...defaults, tao: { ...defaults.tao,
      edge: oldTao.position ?? "right", width: oldTao.width ?? 360, height: oldTao.height ?? 280,
      pinned: oldTao.pinned ?? true, opacity: oldTao.floatingOpacity ?? 1 } })!.tao;
    try { storage.setItem(SHELL_LAYOUT_KEY, JSON.stringify(defaults)); }
    catch { return { layout: defaults, warning: "write", writable: true }; }
    return { layout: defaults, warning: null, writable: true };
  } catch { return { layout: defaults, warning: "read", writable: true }; }
}
