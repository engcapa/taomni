import { memo } from "react";
import { Ban, ChevronDown, FileText, Paperclip } from "lucide-react";
import { type MailFolder } from "../../../lib/mail";
import { type MailThreadRow } from "../../../lib/mailThreads";
import { isJunk, messageTags } from "../../../lib/mailTags";
import { type MailRowActions } from "./MailRowActions";
import { isUnread } from "./folders";
import { isFlagged, addressLabel, formatShortDate } from "./messages";
import { decodeFolderLabel } from "./compose";


// Body/progress changes should not rebuild every message row. Event handlers
// consult the current actions so menus and multi-selection never use stale state.
export const MailListRow = memo(function MailListRow({ message, threadKey, depth, isRoot, threadSize, threadUnread, expanded, active, checked, threadView, selectedFolder, displayFolders, actions }: MailThreadRow & {
  active: boolean;
  checked: boolean;
  threadView: boolean;
  selectedFolder: string;
  displayFolders: MailFolder[];
  actions: { current: MailRowActions | null };
}) {
  const unread = isUnread(message);
  return (
    <div
      data-thread-key={threadView ? threadKey : undefined}
      data-thread-depth={threadView ? depth : undefined}
      style={{
        // Offscreen rows skip layout/paint (TASK-22) while
        // staying in the DOM for find, a11y and selection.
        contentVisibility: "auto",
        containIntrinsicSize: "auto 82px",
        ...(threadView && depth > 0 ? { paddingLeft: `${12 + depth * 16}px` } : {}),
      }}
      draggable
      onDragStart={(event) => {
        actions.current!.dragStart(event, message);
      }}
      onDragEnd={() => {
        actions.current!.dragEnd();
      }}
      role="button"
      tabIndex={0}
      aria-pressed={active}
      data-testid="mail-message-row"
      data-uid={message.uid}
      data-checked={checked ? "true" : "false"}
      data-unread={unread ? "true" : "false"}
      data-flagged={isFlagged(message) ? "true" : "false"}
      className={`w-full min-h-[82px] px-3 py-2.5 text-left border-b border-[var(--taomni-divider)] hover:bg-[var(--taomni-hover)] cursor-pointer ${active || checked ? "bg-[var(--taomni-selected)]" : ""}`}
      onClick={(event) => {
        if (event.shiftKey || event.ctrlKey || event.metaKey) {
          actions.current!.toggleMessageChecked(message, event.shiftKey || !checked, event.shiftKey);
        } else {
          actions.current!.selectListMessage(message);
        }
      }}
      onDoubleClick={() => actions.current!.openMessageTab(message)}
      onContextMenu={(event) => actions.current!.contextMenu(event, message)}
      onKeyDown={(event) => {
        if (event.key !== "Enter" && event.key !== " ") return;
        event.preventDefault();
        actions.current!.selectListMessage(message);
      }}
    >
      <div className="flex items-start gap-2">
        <input
          type="checkbox"
          className="taomni-checkbox mt-1 shrink-0"
          aria-label={`Select ${message.subject || "message"}`}
          checked={checked}
          onClick={(event) => event.stopPropagation()}
          onKeyDown={(event) => {
            if (event.key === " " || event.key === "Enter") event.stopPropagation();
          }}
          onChange={(event) => actions.current!.toggleMessageChecked(message, event.target.checked, (event.nativeEvent as MouseEvent).shiftKey)}
        />
        {threadView && isRoot && threadSize > 1 && (
          <button
            type="button"
            className="mt-0.5 shrink-0 inline-flex items-center gap-0.5 rounded px-1 text-[11px] text-[var(--taomni-text-muted)] hover:bg-[var(--taomni-hover)]"
            data-testid="mail-thread-expand"
            aria-expanded={expanded}
            aria-label={`${expanded ? "Collapse" : "Expand"} conversation of ${threadSize} messages`}
            onClick={(event) => {
              event.stopPropagation();
              actions.current!.toggleThreadExpanded(threadKey);
            }}
          >
            <ChevronDown className={`w-3 h-3 transition-transform ${expanded ? "" : "-rotate-90"}`} />
            <span data-testid="mail-thread-size">{threadSize}</span>
            {threadUnread > 0 && !expanded && (
              <span className="text-[var(--taomni-accent)]">({threadUnread})</span>
            )}
          </button>
        )}
        <div className="min-w-0 flex-1">
          <div className="min-w-0 flex items-center gap-1.5">
            {isJunk(message) && (
              <span title="Junk" data-testid="mail-message-junk" className="shrink-0 text-[var(--taomni-text-muted)]">
                <Ban className="w-3 h-3" />
              </span>
            )}
            <div className={`min-w-0 text-[14px] leading-5 truncate ${unread ? "font-semibold text-[var(--taomni-text)]" : "font-medium text-[var(--taomni-text-muted)]"}`}>
              {message.subject || "(no subject)"}
            </div>
            {messageTags(message).map((tag) => (
              <span
                key={tag.keyword}
                className="shrink-0 inline-block w-2 h-2 rounded-full"
                style={{ background: tag.color }}
                title={tag.label}
                data-testid="mail-message-tag"
                data-tag={tag.keyword}
              />
            ))}
          </div>
          <div className="mt-1 flex items-center gap-1.5 text-[12px] leading-4">
            <span className={`min-w-0 truncate ${unread ? "font-semibold text-[var(--taomni-text)]" : "text-[var(--taomni-text-muted)]"}`}>
              {addressLabel(message.from) || "(unknown)"}
            </span>
            {message.folder !== selectedFolder && (
              <span
                className="shrink-0 rounded border border-[var(--taomni-divider)] px-1 text-[10px] text-[var(--taomni-text-muted)]"
                data-testid="mail-message-folder"
              >
                {decodeFolderLabel(message.folder, displayFolders)}
              </span>
            )}
            {message.hasAttachments && <Paperclip className="w-3 h-3 text-[var(--taomni-text-muted)] shrink-0" />}
            {message.bodyCached && <FileText className="w-3 h-3 text-[var(--taomni-accent)] shrink-0" />}
          </div>
          <div className="text-[11px] text-[var(--taomni-text-muted)] line-clamp-2 mt-1.5">
            {message.snippet || "No preview"}
          </div>
        </div>
        <span className="text-[11px] text-[var(--taomni-text-muted)] shrink-0 leading-5">{formatShortDate(message.dateTs)}</span>
      </div>
    </div>
  );
});
