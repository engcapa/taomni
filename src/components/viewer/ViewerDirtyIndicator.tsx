import { useDocumentStore } from "../../stores/documentStore";
import { viewerHasChanges } from "../../lib/openFile/closeGuard";

export function ViewerDirtyIndicator({ path }: { path: string }) {
  const dirty = useDocumentStore((state) => viewerHasChanges(path, state));
  if (!dirty) return null;
  return <span data-testid="viewer-tab-dirty" aria-label="Unsaved changes" className="h-[7px] w-[7px] shrink-0 rounded-full bg-[var(--taomni-warning-icon)]" />;
}
