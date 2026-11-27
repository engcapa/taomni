import { usePluginFrontendStore } from "../../stores/pluginFrontendStore";
import { useModuleMarketplaceStore } from "../../stores/moduleMarketplaceStore";
import { classifyFile, fileExtension } from "./classifyFile";
import { officialDocumentFormats, type DocumentProvider } from "./documentFormats";

export function documentProvider(path: string, projectXml = false): DocumentProvider | undefined {
  const kind = classifyFile(path);
  const extension = fileExtension(path);
  if (extension === "xml" && projectXml) return { slug: "taoffice-project", name: "MS Project" };
  if (kind !== "document" && kind !== "binary" && kind !== "pdf") return;
  const official = officialDocumentFormats.get(extension);
  const matches = (provider: { slug: string; document?: { extensions: string[] } }) =>
    (!official || official.slug === provider.slug) && provider.document?.extensions.includes(extension);
  const records = Object.values(usePluginFrontendStore.getState().records);
  const installed = records.filter((record) => record.manifest && matches(record.manifest))
    .sort((a, b) => Number(b.lifecycle === "enabled") - Number(a.lifecycle === "enabled") || a.slug.localeCompare(b.slug))[0];
  if (installed?.manifest) return { slug: installed.slug, name: installed.manifest.name };
  const { catalog, source, catalogSource } = useModuleMarketplaceStore.getState();
  if (catalog && catalogSource === source) {
    const published = Object.values(catalog.catalog.plugins)
      .filter((entry) => entry.platforms[catalog.platform] && matches(entry))
      .sort((a, b) => a.slug.localeCompare(b.slug))[0];
    if (published) return { slug: published.slug, name: published.name };
  }
  return official;
}
