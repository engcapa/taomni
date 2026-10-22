import { ChevronDown, ChevronLeft, ChevronRight, File, Pin, X } from "lucide-react";
import { FileTypeIcon } from "../fileTypeIcon";
import { useEditorGroupTabs } from "./useEditorGroupTabs";

export interface EditorGroupTabsProps {
  openOrder: string[];
  tabs: ReturnType<typeof useEditorGroupTabs>;
  openFiles: Record<string, import("../editorGroupTypes").OpenFileViewModel>;
  activeKey: string | null;
  previewKey: string | null;
  onActivate: (key: string) => void;
  onPromotePreview: (key: string) => void;
  onClose: (key: string) => void;
  filesWithErrors: ReadonlySet<string> | undefined;
}

export function EditorGroupTabs(props: EditorGroupTabsProps) {
  const { openOrder, tabs, openFiles, activeKey, previewKey, onActivate, onPromotePreview, onClose, filesWithErrors } = props;
  return (<>{openOrder.length > 0 && tabs.isSeparatePinnedRow && tabs.separatePinnedKeys.length > 0 && (
    <div
      data-testid="code-workspace-editor-pinned-tab-strip"
      role="tablist"
      aria-label="Pinned editor tabs"
      className="shrink-0 flex items-stretch border-b border-[var(--taomni-code-border)] bg-[var(--taomni-code-gutter-bg)] overflow-x-auto taomni-tab-scroll"
      style={{ height: "var(--taomni-code-editor-tab-height)" }}
    >
      {tabs.separatePinnedKeys.map((key) => {
        const file = openFiles[key];
        if (!file) return null;
        const active = key === activeKey;
        const preview = key === previewKey;
        const pinned = true;
        return (
          <div
            key={key}
            data-editor-tab-key={key}
            data-active={active || undefined}
            data-preview={preview || undefined}
            data-pinned={pinned || undefined}
            role="tab"
            aria-selected={active}
            className="h-full min-w-[96px] max-w-[240px] flex items-center border-r border-[var(--taomni-code-border)] text-[length:var(--taomni-code-editor-ui-small-font-size)] text-[var(--taomni-code-muted)] data-[active=true]:bg-[var(--taomni-code-bg)] data-[active=true]:text-[var(--taomni-code-text)]"
          >
            <button
              type="button"
              className="min-w-0 flex-1 h-full flex items-center gap-1.5 px-2 text-left hover:bg-[var(--taomni-code-active-line-bg)]"
              title={file.subtitle}
              onClick={() => onActivate(key)}
              onDoubleClick={() => onPromotePreview(key)}
              onAuxClick={(event) => {
                if (event.button === 1) onClose(key);
              }}
              onContextMenu={(event) => tabs.showTabMenu(event, key)}
            >
              <File className="w-3.5 h-3.5 shrink-0 text-[var(--taomni-code-muted)]" />
              <Pin className="h-3 w-3 shrink-0" />
              <span className={`truncate ${preview ? "italic" : ""}`}>{file.title}</span>
              {file.dirty && <span className="text-[var(--taomni-accent)]">*</span>}
            </button>
            <button
              type="button"
              className="h-full w-6 shrink-0 inline-flex items-center justify-center hover:bg-[var(--taomni-code-active-line-bg)]"
              title="Close"
              onClick={() => onClose(key)}
            >
              <X className="w-3 h-3" />
            </button>
          </div>
        );
      })}
    </div>
  )}
    {openOrder.length > 0 && (
      <div
        data-testid="code-workspace-editor-tab-strip"
        role="tablist"
        aria-label="Editor tabs"
        className="shrink-0 flex items-stretch border-b border-[var(--taomni-code-border)] bg-[var(--taomni-code-gutter-bg)]"
        style={{ height: "var(--taomni-code-editor-tab-height)" }}
      >
        {/*
            Scroll track is height-matched to tab content via the CSS token (not rem h-8,
            which collapses to 24px under the 12px app root font). Classic native scrollbars
            are suppressed via taomni-tab-scroll so they cannot steal vertical space.
            Chevron buttons and the all-tabs menu stay outside the scroll track.
          */}
        {tabs.tabScrollState.overflow && (
          <button
            type="button"
            data-testid="code-workspace-editor-tab-scroll-left"
            aria-label="Scroll editor tabs left"
            title="Scroll tabs left"
            disabled={tabs.tabScrollState.atStart}
            className="h-full w-7 shrink-0 inline-flex items-center justify-center border-r border-[var(--taomni-code-border)] hover:bg-[var(--taomni-code-active-line-bg)] disabled:opacity-40"
            onClick={() => tabs.scrollTabsBy("left")}
          >
            <ChevronLeft className="h-3.5 w-3.5" />
          </button>
        )}
        <div
          ref={tabs.tabScrollRef}
          data-testid="code-workspace-editor-tab-scroll"
          className="taomni-tab-scroll min-w-0 flex-1 flex items-stretch overflow-x-auto overflow-y-hidden"
          onScroll={tabs.updateTabScrollState}
        >
          {tabs.normalDisplayKeys.map((key) => {
            const file = openFiles[key];
            if (!file) return null;
            const active = key === activeKey;
            const preview = key === previewKey;
            const pinned = tabs.pinnedSet.has(key);
            return (
              <div
                key={key}
                data-editor-tab-key={key}
                data-active={active || undefined}
                data-preview={preview || undefined}
                data-pinned={pinned || undefined}
                data-dirty={file.dirty || undefined}
                data-has-errors={filesWithErrors?.has(key) || undefined}
                role="presentation"
                className="relative h-full min-w-[96px] max-w-[240px] flex items-center border-r border-[var(--taomni-code-border)] text-[length:var(--taomni-code-editor-ui-small-font-size)] text-[var(--taomni-code-muted)] data-[active=true]:bg-[var(--taomni-code-bg)] data-[active=true]:text-[var(--taomni-code-text)] data-[active=true]:after:pointer-events-none data-[active=true]:after:absolute data-[active=true]:after:inset-x-1 data-[active=true]:after:inset-y-1 data-[active=true]:after:rounded-md data-[active=true]:after:border data-[active=true]:after:border-[var(--taomni-accent)]/70"
              >
                <button
                  type="button"
                  role="tab"
                  aria-selected={active}
                  className="min-w-0 flex-1 h-full flex items-center gap-1.5 px-2 text-left hover:bg-[var(--taomni-code-active-line-bg)]"
                  title={file.subtitle}
                  onClick={() => onActivate(key)}
                  onDoubleClick={() => onPromotePreview(key)}
                  onAuxClick={(event) => {
                    if (event.button === 1) onClose(key);
                  }}
                  onContextMenu={(event) => tabs.showTabMenu(event, key)}
                >
                  <FileTypeIcon path={file.languagePath ?? file.title} />
                  {pinned && <Pin className="h-3 w-3 shrink-0" />}
                  <span
                    className={`truncate ${preview ? "italic" : ""} ${filesWithErrors?.has(key) ? "underline decoration-wavy decoration-red-500 underline-offset-2" : ""}`}
                  >
                    {file.title}
                  </span>
                  {file.dirty && <span className="text-[var(--taomni-accent)]">*</span>}
                </button>
                <button
                  type="button"
                  className="h-full w-6 shrink-0 inline-flex items-center justify-center hover:bg-[var(--taomni-code-active-line-bg)]"
                  title="Close"
                  aria-label={`Close ${file.title}`}
                  onClick={() => onClose(key)}
                >
                  <X className="w-3 h-3" />
                </button>
              </div>
            );
          })}
        </div>
        {tabs.tabScrollState.overflow && (
          <button
            type="button"
            data-testid="code-workspace-editor-tab-scroll-right"
            aria-label="Scroll editor tabs right"
            title="Scroll tabs right"
            disabled={tabs.tabScrollState.atEnd}
            className="h-full w-7 shrink-0 inline-flex items-center justify-center border-l border-[var(--taomni-code-border)] hover:bg-[var(--taomni-code-active-line-bg)] disabled:opacity-40"
            onClick={() => tabs.scrollTabsBy("right")}
          >
            <ChevronRight className="h-3.5 w-3.5" />
          </button>
        )}
        {openOrder.length > 1 && (
          <button
            type="button"
            data-testid="code-workspace-editor-tabs-menu"
            aria-label="Show all editor tabs"
            className="h-full w-7 shrink-0 inline-flex items-center justify-center border-l border-[var(--taomni-code-border)] hover:bg-[var(--taomni-code-active-line-bg)]"
            onClick={(event) => {
              const rect = event.currentTarget.getBoundingClientRect();
              tabs.tabMenu.showAt(rect.right, rect.bottom, tabs.orderedKeys.map((key) => ({
                label: openFiles[key]?.title ?? key,
                checked: key === activeKey,
                onClick: () => onActivate(key),
              })));
            }}
          >
            <ChevronDown className="h-3.5 w-3.5" />
          </button>
        )}
      </div>
    )}
  </>);
}
