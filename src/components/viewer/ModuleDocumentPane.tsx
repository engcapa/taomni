import { useEffect, useId, useState } from "react";
import { FileText, Package, Shield } from "lucide-react";
import type { FileViewerTabInfo } from "../../types";
import { fileExtension } from "../../lib/openFile/classifyFile";
import { documentProvider } from "../../lib/openFile/documentProvider";
import { usePluginFrontendRegistry } from "../../lib/usePluginFrontendRegistry";
import { usePluginFrontendStore } from "../../stores/pluginFrontendStore";
import { useModuleMarketplaceStore } from "../../stores/moduleMarketplaceStore";
import { openSettingsSection } from "../../lib/settingsNavigation";
import { basename, sftpOpenPath } from "../../lib/sftp";
import { openDocumentMedia, readModuleDocument, type MediaSourceLease } from "../../lib/openFile/mediaStream";
import { PluginTabPane } from "../plugins/PluginTabPane";
import { useViewerLabels } from "./viewerLabels";
import "./moduleDocument.css";

/** The renderer receives operations bound to this document, never a general path reader. */
export interface ModuleDocumentInput {
  document: {
    name: string;
    extension: string;
    readOnly: boolean;
    read: () => Promise<Blob>;
    openMedia: (mime: string) => Promise<MediaSourceLease>;
    openSystem: () => Promise<void>;
  };
}

export function ModuleDocumentPane({ viewer, active }: { viewer: FileViewerTabInfo; active: boolean }) {
  const label = useViewerLabels();
  const id = useId();
  const state = usePluginFrontendRegistry();
  useModuleMarketplaceStore((store) => store.catalog);
  const provider = documentProvider(viewer.path);
  const slug = provider?.slug ?? "";
  const extension = fileExtension(viewer.path);
  const name = basename(viewer.path);
  const record = state.records[slug];
  const epoch = state.epochs[slug] ?? 0;
  const version = record?.manifest?.version;
  const permitted = record?.manifest?.permissions.includes("fs.readUserFile") === true;
  const enabled = permitted && state.status === "ready" && !state.pending.has(slug) && record?.lifecycle === "enabled"
    && record.manifest?.document?.extensions.includes(extension) === true;
  const [input, setInput] = useState<ModuleDocumentInput>();
  const [error, setError] = useState("");
  const readOnly = !!viewer.readOnlyReason || (!!viewer.source && viewer.source !== "local");
  const path = viewer.path;

  useEffect(() => {
    setError("");
    if (!enabled || !version) { setInput(undefined); return; }
    let alive = true;
    const ensureCurrent = () => {
      const current = usePluginFrontendStore.getState();
      if (!alive || current.status !== "ready" || current.pending.has(slug) || (current.epochs[slug] ?? 0) !== epoch
        || current.records[slug]?.lifecycle !== "enabled" || current.records[slug]?.manifest?.version !== version) {
        throw new DOMException("Document was closed or its module changed", "AbortError");
      }
    };
    const leases = new Set<MediaSourceLease>();
    setInput({ document: { name, extension, readOnly, openMedia: async (mime) => {
      ensureCurrent();
      const lease = await openDocumentMedia(path, mime, slug, version);
      try { ensureCurrent(); } catch (error) { lease.close(); throw error; }
      leases.add(lease);
      return { url: lease.url, close: () => { if (leases.delete(lease)) lease.close(); } };
    }, openSystem: async () => {
      ensureCurrent();
      await sftpOpenPath(path);
    }, read: async () => {
      ensureCurrent();
      const data = await readModuleDocument(path, slug, version);
      ensureCurrent();
      return new Blob([Uint8Array.from(data.bytes)], { type: data.mime });
    } } });
    return () => {
      alive = false;
      for (const lease of leases) lease.close();
      leases.clear();
    };
  }, [enabled, path, name, extension, slug, epoch, version, readOnly]);

  const systemAction = <button type="button" className="taomni-btn" data-testid="document-open-system"
    onClick={() => { setError(""); void sftpOpenPath(path).catch((reason) => setError(String(reason))); }}>
    {label("用系统应用打开", "Open in system app")}
  </button>;
  const loading = state.status === "idle" || state.status === "loading" || state.pending.has(slug);
  const unavailable = record?.lifecycle === "disabled" ? label("已禁用", "is disabled")
    : record?.lifecycle === "enabled" && !permitted ? label("没有读取所选文件的权限", "does not have permission to read the selected file")
    : record?.lifecycle === "enabled" ? label("不支持此扩展名", "does not support this extension")
    : record?.lifecycle === "installed" ? label("尚未启用", "is not enabled") : label("尚未安装", "is not installed");
  return <section className="fv module-document" data-testid="file-viewer" data-active={active}
    data-kind={viewer.kind} data-path={path} data-module={slug} aria-label={name}>
    {readOnly && <div className="fv-banner info" role="status" data-testid="document-readonly">
      <Shield size={16} aria-hidden="true" />{viewer.readOnlyReason || label("只读副本", "Read-only copy")}
    </div>}
    {enabled && input ? <PluginTabPane<ModuleDocumentInput> tab={{ id, plugin: { slug, kind: "document" } }}
      active={active} componentProps={input} unavailableActions={systemAction}
      onOpenSettings={() => openSettingsSection("module-store")} />
      : loading || enabled ? <span role="status">{label("正在打开文档…", "Opening document…")}</span>
      : <div className="module-document-empty" data-testid="document-module-state">
        <FileText aria-hidden="true" />
        <h2>{name}</h2>
        {state.status === "failed" ? <p role="alert">{label("无法读取模块状态", "Cannot read module status")} · {state.error}</p>
          : <p>{provider?.name ?? extension} {unavailable}</p>}
        <div className="module-document-actions">
          {state.status === "failed" && <button type="button" className="taomni-btn" onClick={() => void state.refresh(slug)}>
            {label("重试", "Retry")}</button>}
          <button type="button" className="taomni-btn" data-testid="document-open-store" onClick={() => openSettingsSection("module-store")}>
            <Package size={16} aria-hidden="true" />{label("打开模块商店", "Open module store")}</button>
          {systemAction}
        </div>
      </div>}
    {error && <p role="alert" className="fv-banner warn">{label("系统应用打开失败，请检查文件关联后重试", "Could not open the system app. Check its file association and retry.")} {error}</p>}
  </section>;
}
