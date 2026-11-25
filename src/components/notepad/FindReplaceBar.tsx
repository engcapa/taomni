import {
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";
import { List, Replace, X } from "lucide-react";
import { readSearchHistory, recordSearchHistory } from "../../lib/notepad/search/engine";
import { validateSearchPattern, type NotepadSearchMode } from "../../lib/notepad/transforms/escape";
import type { NotepadFindState, NotepadFindTab } from "../../stores/notepadStore";
import { useViewerLabels } from "../viewer/viewerLabels";
import "./notepad-findbar.css";

type FindOptionKey =
  | "caseSensitive"
  | "wholeWord"
  | "wrapAround"
  | "backward"
  | "inSelection"
  | "dotAll"
  | "highlightAll"
  | "incremental";

const FIND_TABS: Array<{ id: NotepadFindTab; zh: string; en: string }> = [
  { id: "find", zh: "查找", en: "Find" },
  { id: "replace", zh: "替换", en: "Replace" },
  { id: "files", zh: "在文件中查找", en: "Find in Files" },
  { id: "mark", zh: "标记", en: "Mark" },
];

const SEARCH_MODES: Array<{ id: NotepadSearchMode; zh: string; en: string }> = [
  { id: "normal", zh: "普通", en: "Normal" },
  { id: "ext", zh: "扩展 (\\n \\t \\0 \\x)", en: "Extended (\\n \\t \\0 \\x)" },
  { id: "re", zh: "正则", en: "RegEx" },
];

const FIND_OPTIONS: Array<{ key: FindOptionKey; testId: string; zh: string; en: string }> = [
  { key: "caseSensitive", testId: "notepad-flag-case", zh: "区分大小写", en: "Match case" },
  { key: "wholeWord", testId: "notepad-flag-word", zh: "全词匹配", en: "Whole word" },
  { key: "wrapAround", testId: "notepad-flag-wrap", zh: "循环", en: "Wrap around" },
  { key: "backward", testId: "notepad-flag-back", zh: "反向", en: "Backward" },
  { key: "inSelection", testId: "notepad-flag-sel", zh: "仅选区内", en: "In selection" },
  { key: "dotAll", testId: "notepad-flag-dotall", zh: ". 匹配换行", en: ". matches newline" },
  { key: "highlightAll", testId: "notepad-flag-hl", zh: "高亮全部", en: "Highlight all" },
  { key: "incremental", testId: "notepad-flag-inc", zh: "增量查找", en: "Incremental" },
];

const MARK_STYLES = [1, 2, 3, 4, 5] as const;

/** Tight wrapper that keeps the legacy `notepad-*` testid available next to the new `np-find-*` one. */
function LegacyId({ id, className, children }: { id: string; className?: string; children: ReactNode }) {
  return (
    <span
      role="presentation"
      className={className ? `np-find-legacy ${className}` : "np-find-legacy"}
      data-testid={id}
    >
      {children}
    </span>
  );
}

/** Turn the parent's English action status into the prototype's message-line phrasing. */
function formatFindStatus(statusText: string, label: (zh: string, en: string) => string): string {
  const countMatch = /^(\d+)\s+match\(es\)\.$/.exec(statusText);
  if (countMatch) {
    return label(`当前文档匹配 ${countMatch[1]} 处`, `${countMatch[1]} match(es) in the current document`);
  }
  return statusText;
}

// `onCopyMarked` is rendered in the Mark tab and copies all marked matches.
export function FindReplaceBar({
  find,
  statusText,
  searchingFiles,
  onPatch,
  onFindNext,
  onFindPrev,
  onIncrementalSearch,
  onCount,
  onFindAllCurrent,
  onFindAllOpen,
  onReplaceOne,
  onReplaceAll,
  onReplaceAllOpen,
  onFindInFiles,
  onCancelFindInFiles,
  onReplaceInFiles,
  onMarkAll,
  onClearMarks,
  onCopyMarked,
  onClose,
}: {
  find: NotepadFindState;
  statusText: string | null;
  searchingFiles: boolean;
  onPatch: (patch: Partial<NotepadFindState>) => void;
  onFindNext: () => void;
  onFindPrev: () => void;
  onIncrementalSearch?: (query: string) => void;
  onCount: () => void;
  onFindAllCurrent: () => void;
  onFindAllOpen: () => void;
  onReplaceOne: () => void;
  onReplaceAll: () => void;
  onReplaceAllOpen: () => void;
  onFindInFiles: () => void;
  onCancelFindInFiles: () => void;
  onReplaceInFiles: () => void;
  onMarkAll: (bookmarkLines: boolean, purgePrev: boolean) => void;
  onClearMarks: () => void;
  onCopyMarked: () => void;
  onClose: () => void;
}) {
  const label = useViewerLabels();
  const instanceId = useId().replace(/:/g, "");
  const findListId = `np-find-history-${instanceId}`;
  const replaceListId = `np-replace-history-${instanceId}`;

  const [portalHost, setPortalHost] = useState<HTMLElement | null>(null);
  const [position, setPosition] = useState<{ left: number; top: number } | null>(null);
  const [purgePrev, setPurgePrev] = useState(true);
  const [findHistory, setFindHistory] = useState<readonly string[]>(() => readSearchHistory("find"));
  const [replaceHistory, setReplaceHistory] = useState<readonly string[]>(() => readSearchHistory("replace"));
  const panelRef = useRef<HTMLElement | null>(null);
  const anchorRef = useRef<HTMLSpanElement | null>(null);
  const findInputRef = useRef<HTMLInputElement | null>(null);
  const wasOpenRef = useRef(false);
  const dragRef = useRef<{ dx: number; dy: number } | null>(null);
  const countRef = useRef(onCount);
  countRef.current = onCount;

  // The panel must float over the editor area (below the toolbar, inside the editor
  // column), so it is portalled into `.np-editor-column` and positioned absolutely there.
  // Keep the anchor mounted continuously so `portalHost` is resolved without a 1-frame flash.
  useLayoutEffect(() => {
    const workbench = anchorRef.current?.closest(".np-workbench") ?? null;
    setPortalHost(workbench?.querySelector<HTMLElement>(".np-editor-column") ?? null);
  }, [find.open]);

  useEffect(() => {
    if (find.open && !wasOpenRef.current) {
      queueMicrotask(() => {
        findInputRef.current?.focus();
        findInputRef.current?.select();
      });
    }
    wasOpenRef.current = find.open;
  }, [find.open]);

  const patternErr = validateSearchPattern({
    query: find.query,
    mode: find.mode,
    caseSensitive: find.caseSensitive,
    wholeWord: find.wholeWord,
    dotAll: find.dotAll,
  });

  // Live match count for the prototype's message line, routed through the parent's
  // `onCount` action because this component has no document-content prop.
  useEffect(() => {
    if (!find.open || !find.query || patternErr) return;
    const timer = window.setTimeout(() => countRef.current(), 250);
    return () => window.clearTimeout(timer);
  }, [find.open, find.query, find.mode, find.caseSensitive, find.wholeWord, find.dotAll, patternErr]);

  if (!find.open) {
    return <span ref={anchorRef} className="np-find-anchor" aria-hidden="true" />;
  }

  const rememberFind = (value: string) => {
    if (!value) return;
    recordSearchHistory("find", value);
    setFindHistory(readSearchHistory("find"));
  };
  const rememberReplace = (value: string) => {
    if (!value) return;
    recordSearchHistory("replace", value);
    setReplaceHistory(readSearchHistory("replace"));
  };

  const clampToContainingBlock = (left: number, top: number, panel: HTMLElement) => {
    const parent = panel.offsetParent as HTMLElement | null;
    const maxLeft = parent ? Math.max(0, parent.clientWidth - panel.offsetWidth) : Math.max(0, window.innerWidth - panel.offsetWidth);
    const maxTop = parent ? Math.max(0, parent.clientHeight - panel.offsetHeight) : Math.max(0, window.innerHeight - panel.offsetHeight);
    return { left: Math.max(0, Math.min(left, maxLeft)), top: Math.max(0, Math.min(top, maxTop)) };
  };

  const handleHeaderPointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    const target = event.target as HTMLElement | null;
    if (target?.closest("button, input, select, textarea, a, label")) return;
    const panel = panelRef.current;
    if (!panel) return;
    const rect = panel.getBoundingClientRect();
    dragRef.current = { dx: event.clientX - rect.left, dy: event.clientY - rect.top };
    event.currentTarget.setPointerCapture(event.pointerId);
    event.preventDefault();
  };

  const handleHeaderPointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current;
    const panel = panelRef.current;
    if (!drag || !panel) return;
    const parent = panel.offsetParent as HTMLElement | null;
    const parentRect = parent?.getBoundingClientRect();
    const next = clampToContainingBlock(
      event.clientX - drag.dx - (parentRect?.left ?? 0),
      event.clientY - drag.dy - (parentRect?.top ?? 0),
      panel,
    );
    setPosition(next);
  };

  const handleHeaderPointerUp = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (!dragRef.current) return;
    dragRef.current = null;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
  };

  const handlePanelKeyDown = (event: ReactKeyboardEvent<HTMLElement>) => {
    if (event.key === "Escape") {
      event.stopPropagation();
      onClose();
    }
  };

  const commitFindAndRun = (action: () => void) => {
    rememberFind(find.query);
    action();
  };
  const commitReplaceAndRun = (action: () => void) => {
    rememberFind(find.query);
    rememberReplace(find.replace);
    action();
  };

  const swapFindReplace = () => {
    onPatch({ query: find.replace, replace: find.query });
  };

  const toggleOption = (key: FindOptionKey, checked: boolean) => {
    const patch = { [key]: checked } as Pick<NotepadFindState, FindOptionKey>;
    onPatch(patch);
  };

  const message = patternErr ? null : find.query && statusText ? formatFindStatus(statusText, label) : null;
  const panelStyle: CSSProperties = {
    opacity: find.opacity,
    ...(position ? { left: position.left, top: position.top, right: "auto" as const } : {}),
  };

  const findRow = (
    <div className="np-find-row" data-testid="notepad-find-input">
      <label className="np-find-label">{label("查找", "Find")}</label>
      <input
        ref={findInputRef}
        type="text"
        className="np-find-input"
        data-testid="np-find-input"
        list={findListId}
        value={find.query}
        onChange={(event) => {
          const nextQuery = event.target.value;
          onPatch({ query: nextQuery });
          if (find.incremental && nextQuery) {
            onIncrementalSearch?.(nextQuery);
          }
        }}
        onKeyDown={(event) => {
          if (event.key !== "Enter") return;
          event.preventDefault();
          if (event.shiftKey) commitFindAndRun(onFindPrev);
          else commitFindAndRun(onFindNext);
        }}
      />
      <datalist id={findListId}>
        {findHistory.map((item) => (
          <option key={item} value={item} />
        ))}
      </datalist>
    </div>
  );

  const replaceRow = (
    <div className="np-find-row" data-testid="notepad-replace-input">
      <label className="np-find-label">{label("替换为", "Replace with")}</label>
      <input
        type="text"
        className="np-find-input"
        data-testid="np-find-replace-input"
        list={replaceListId}
        value={find.replace}
        onChange={(event) => onPatch({ replace: event.target.value })}
        onKeyDown={(event) => {
          if (event.key !== "Enter") return;
          event.preventDefault();
          commitReplaceAndRun(onReplaceOne);
        }}
      />
      <datalist id={replaceListId}>
        {replaceHistory.map((item) => (
          <option key={item} value={item} />
        ))}
      </datalist>
      <button
        type="button"
        className="np-find-icon-btn"
        data-testid="np-find-swap"
        title={label("互换", "Swap")}
        onClick={swapFindReplace}
      >
        <Replace size={13} />
      </button>
    </div>
  );

  const modeRow = (
    <div className="np-find-row">
      <label className="np-find-label">{label("模式", "Mode")}</label>
      <div className="np-find-seg" role="group">
        {SEARCH_MODES.map((mode) => (
          <button
            key={mode.id}
            type="button"
            className={`np-find-seg-btn${find.mode === mode.id ? " on" : ""}`}
            data-testid={`notepad-mode-${mode.id}`}
            onClick={() => onPatch({ mode: mode.id })}
          >
            {label(mode.zh, mode.en)}
          </button>
        ))}
      </div>
    </div>
  );

  const optionsGrid = (
    <div className="np-find-opts">
      {FIND_OPTIONS.map((option) => (
        <label key={option.key} className="np-find-opt">
          <input
            type="checkbox"
            data-testid={option.testId}
            checked={find[option.key]}
            onChange={(event) => toggleOption(option.key, event.target.checked)}
          />
          {label(option.zh, option.en)}
        </label>
      ))}
    </div>
  );

  const messageLine = (
    <div className={`np-find-message${patternErr ? " error" : ""}`} data-testid="notepad-find-status" title={patternErr ?? undefined}>
      {patternErr ?? message}
    </div>
  );

  const actionButton = (
    testId: string,
    legacyId: string | null,
    text: string,
    onClick: () => void,
    primary = false,
  ) => {
    const button = (
      <button
        type="button"
        className={`np-find-btn${primary ? " primary" : ""}`}
        data-testid={testId}
        onClick={onClick}
      >
        {text}
      </button>
    );
    return legacyId ? (
      <LegacyId key={legacyId} id={legacyId}>
        {button}
      </LegacyId>
    ) : (
      <span key={testId}>{button}</span>
    );
  };

  const tabActions = {
    find: (
      <>
        {actionButton("np-find-next", "notepad-find-next", label("查找下一个", "Find Next"), () => commitFindAndRun(onFindNext), true)}
        {actionButton("np-find-prev", "notepad-find-prev", label("上一个", "Find Previous"), () => commitFindAndRun(onFindPrev))}
        {actionButton("np-find-count", "notepad-find-count", label("计数", "Count"), () => commitFindAndRun(onCount))}
        {actionButton("np-find-all-current", "notepad-find-all-current", label("全部查找（当前）", "Find All (Current)"), () => commitFindAndRun(onFindAllCurrent))}
        {actionButton("np-find-all-open", "notepad-find-all-open", label("全部查找（所有文档）", "Find All (Open Documents)"), () => commitFindAndRun(onFindAllOpen))}
      </>
    ),
    replace: (
      <>
        {actionButton("np-find-next", "notepad-find-next", label("查找下一个", "Find Next"), () => commitFindAndRun(onFindNext), true)}
        {actionButton("np-find-replace-one", "notepad-replace-one", label("替换", "Replace"), () => commitReplaceAndRun(onReplaceOne))}
        {actionButton("np-find-replace-all", "notepad-replace-all", label("全部替换", "Replace All"), () => commitReplaceAndRun(onReplaceAll))}
        {actionButton("np-find-replace-all-open", "notepad-replace-all-open", label("在所有打开文档中替换", "Replace All in Open Documents"), () => commitReplaceAndRun(onReplaceAllOpen))}
      </>
    ),
    files: (
      <>
        {searchingFiles
          ? (
            <button
              key="notepad-files-cancel"
              type="button"
              className="np-find-btn"
              data-testid="notepad-files-cancel"
              onClick={onCancelFindInFiles}
            >
              {label("停止搜索", "Stop")}
            </button>
          )
          : actionButton("np-find-in-files", "notepad-files-search", label("在文件中查找", "Find in Files"), () => commitFindAndRun(onFindInFiles), true)}
        {actionButton("np-find-replace-in-files", "notepad-files-replace", label("在文件中替换…", "Replace in Files…"), () => commitReplaceAndRun(onReplaceInFiles))}
      </>
    ),
    mark: (
      <>
        {actionButton("np-find-mark-all", "notepad-mark-all", label("标记全部", "Mark All"), () => commitFindAndRun(() => onMarkAll(false, purgePrev)), true)}
        {actionButton("np-find-mark-bookmark", "notepad-mark-bookmark", label("标记并加书签", "Mark and Bookmark"), () => commitFindAndRun(() => onMarkAll(true, purgePrev)))}
        {actionButton("np-find-copy-marked", "notepad-mark-copy", label("复制标记文本", "Copy Marked Text"), onCopyMarked)}
        {actionButton("np-find-clear-marks", "notepad-mark-clear", label("清除标记", "Clear Marks"), onClearMarks)}
      </>
    ),
  } satisfies Record<NotepadFindTab, ReactNode>;

  const panel = (
    <section
      ref={panelRef}
      className={`np-find np-find-bar np-find-panel${find.compact ? " compact" : ""}`}
      data-testid="np-find-panel"
      data-op={find.opacity}
      style={panelStyle}
      onKeyDown={handlePanelKeyDown}
    >
      <div className="np-find-panel-inner" data-testid="notepad-find-bar">
        <div
          className="np-find-header"
          onPointerDown={handleHeaderPointerDown}
          onPointerMove={handleHeaderPointerMove}
          onPointerUp={handleHeaderPointerUp}
          onPointerCancel={handleHeaderPointerUp}
        >
          <b className="np-find-title">{label(FIND_TABS.find((tab) => tab.id === find.tab)?.zh ?? "查找", FIND_TABS.find((tab) => tab.id === find.tab)?.en ?? "Find")}</b>
          <span className="np-find-context">{label("· 当前文档 / 打开文档 / 目录", "· Current document / Open documents / Directory")}</span>
          <span className="np-find-spacer" />
          <button
            type="button"
            className="np-find-icon-btn"
            data-testid="np-find-compact"
            title={label("紧凑模式", "Compact mode")}
            onClick={() => onPatch({ compact: !find.compact })}
          >
            <List size={13} />
          </button>
          <input
            type="range"
            className="np-find-opacity"
            data-testid="np-find-opacity"
            title={label("透明度", "Opacity")}
            min={40}
            max={100}
            value={Math.round(find.opacity * 100)}
            onChange={(event) => onPatch({ opacity: Number(event.target.value) / 100 })}
          />
          <LegacyId id="notepad-find-close">
            <button
              type="button"
              className="np-find-icon-btn"
              data-testid="np-find-close"
              aria-label={label("关闭", "Close")}
              onClick={onClose}
            >
              <X size={13} />
            </button>
          </LegacyId>
        </div>

        <div className="np-find-tabs" role="tablist">
          {FIND_TABS.map((tab) => (
            <LegacyId key={tab.id} id={`notepad-find-tab-${tab.id}`}>
              <button
                type="button"
                role="tab"
                aria-selected={find.tab === tab.id}
                className={`np-find-tab${find.tab === tab.id ? " on active" : ""}`}
                data-testid={`np-find-tab-${tab.id}`}
                onClick={() => onPatch({ tab: tab.id })}
              >
                {label(tab.zh, tab.en)}
              </button>
            </LegacyId>
          ))}
        </div>

        <div className="np-find-body">
          {findRow}
          {(find.tab === "replace" || find.tab === "files") && replaceRow}
          {find.tab === "files" && (
            <div className="np-find-row">
              <label className="np-find-label">{label("目录", "Directory")}</label>
              <span className="np-find-field">
                <input
                  type="text"
                  className="np-find-input"
                  data-testid="notepad-files-dir"
                  value={find.filesDir}
                  placeholder={label("~", "~")}
                  title={label("双击编辑搜索目录", "Double-click to edit the search folder")}
                  onChange={(event) => onPatch({ filesDir: event.target.value })}
                />
              </span>
              <label className="np-find-inline-label">{label("过滤", "Filters")}</label>
              <input
                type="text"
                className="np-find-input np-find-filter"
                data-testid="notepad-files-filter"
                value={find.filesFilter}
                onChange={(event) => onPatch({ filesFilter: event.target.value })}
              />
            </div>
          )}
          {find.tab === "mark" && (
            <div className="np-find-row">
              <label className="np-find-label">{label("样式", "Style")}</label>
              <div className="np-find-seg" role="group">
                {MARK_STYLES.map((style) => (
                  <button
                    key={style}
                    type="button"
                    className={`np-find-seg-btn${find.markStyle === style ? " on" : ""}`}
                    data-testid={`np-find-mark-style-${style}`}
                    onClick={() => onPatch({ markStyle: style })}
                  >
                    <span className={`np-find-mark-swatch np-find-mark-${style}`}>{label(`样式${style}`, `Style ${style}`)}</span>
                  </button>
                ))}
              </div>
              <label className="np-find-opt ml-auto">
                <input
                  type="checkbox"
                  data-testid="notepad-mark-purge"
                  checked={purgePrev}
                  onChange={(event) => setPurgePrev(event.target.checked)}
                />
                {label("清除上次标记", "Purge for each search")}
              </label>
            </div>
          )}
          {modeRow}
          {optionsGrid}
          {messageLine}
          <div className="np-find-actions">{tabActions[find.tab]}</div>
        </div>
      </div>
    </section>
  );

  return (
    <>
      <span ref={anchorRef} className="np-find-anchor" aria-hidden="true" />
      {portalHost ? createPortal(panel, portalHost) : panel}
    </>
  );
}
