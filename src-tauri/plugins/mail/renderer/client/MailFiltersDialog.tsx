import { Filter as FilterIcon } from "lucide-react";
import { type SetStateAction } from "react";
import { type MailFolder } from "../../../../../src/lib/mail";
import { type MailFilter } from "../../../../../src/lib/mailFilters";
import { folderLabel, isSelectable } from "../../../../../src/lib/mailFolders";
import { MailFiltersPanel } from "../MailFiltersPanel";
import { MailDraggableDialog } from "./MailDraggableDialog";

export interface MailFiltersDialogContext {
  filtersOpen: boolean;
  setFiltersOpen: import("react").Dispatch<SetStateAction<boolean>>;
  setFilterErrors: import("react").Dispatch<SetStateAction<string[]>>;
  filterErrors: string[];
  info: import("../../../../../src/types").MailTabInfo;
  displayFolders: MailFolder[];
  selectedFolder: string;
  filterDraft: MailFilter | null;
  runFiltersOnFolder: (filterIds: string[] | undefined) => Promise<import("../../../../../src/lib/mailFilters").MailFilterRunResult>;
  setStatus: import("react").Dispatch<SetStateAction<string | null>>;
}

export function MailFiltersDialog(context: MailFiltersDialogContext) {
  const {
    filtersOpen,
    setFiltersOpen,
    setFilterErrors,
    filterErrors,
    info,
    displayFolders,
    selectedFolder,
    filterDraft,
    runFiltersOnFolder,
    setStatus,
  } = context;
  return filtersOpen && (
      <MailDraggableDialog
        title="Message filters"
        icon={<FilterIcon className="w-4 h-4 text-[var(--taomni-text-muted)]" />}
        ariaLabel="Message filters"
        closeTestId="mail-filters-close"
        minWidth={460}
        minHeight={320}
        className="w-[min(720px,92vw)] h-[min(560px,80vh)] min-h-[340px]"
        onClose={() => {
          setFiltersOpen(false);
          setFilterErrors([]);
        }}
      >
        <MailFiltersPanel
          recentErrors={filterErrors}
          accountId={info.sessionId}
          folders={displayFolders.filter(isSelectable).map((folder) => ({ name: folder.name, label: folderLabel(folder) }))}
          currentFolder={{
            name: selectedFolder,
            label: folderLabel(displayFolders.find((folder) => folder.name === selectedFolder) ?? { name: selectedFolder, displayName: selectedFolder } as MailFolder),
          }}
          initialDraft={filterDraft}
          onRun={runFiltersOnFolder}
          onStatus={setStatus}
        />
      </MailDraggableDialog>
  );
}
