import { useDocumentStore } from "../../stores/documentStore";
import { documentPathKey } from "../../lib/openFile/pathIdentity";

export function ViewerDirtyIndicator({ path }: { path: string }) {
  const dirty = useDocumentStore((state) => state.documents[documentPathKey(path)]?.dirty ?? false);
  if (!dirty) return null;
  return <span data-testid="viewer-tab-dirty" aria-label="Unsaved changes" className="h-[7px] w-[7px] shrink-0 rounded-full bg-amber-500" />;
}
