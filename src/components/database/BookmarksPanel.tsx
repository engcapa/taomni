import { useEffect, useState, useCallback, useMemo } from "react";
import {
  Search,
  Star,
  Tag,
  Trash2,
  Edit3,
  Plus,
  Play,
  X,
  Clipboard,
  MoreVertical,
  BookMarked,
  FolderOpen,
} from "lucide-react";
import {
  dbListBookmarks,
  dbSaveBookmark,
  dbDeleteBookmark,
  type DbBookmark,
} from "../../lib/ipc";
import { useContextMenu, type MenuItem } from "../ContextMenu";

interface BookmarksPanelProps {
  engine: string;
  activeSql: string;
  activeDatabase?: string | null;
  onSelectBookmark: (sql: string) => void;
  onRunBookmark: (sql: string) => void;
  onAddTriggerRef?: React.MutableRefObject<(() => void) | null>;
}

export function BookmarksPanel({
  engine,
  activeSql,
  activeDatabase,
  onSelectBookmark,
  onRunBookmark,
  onAddTriggerRef,
}: BookmarksPanelProps) {
  const [bookmarks, setBookmarks] = useState<DbBookmark[]>([]);
  const [loading, setLoading] = useState(false);
  const [searchTerm, setSearchTerm] = useState("");
  const [selectedTags, setSelectedTags] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);

  // Modal State
  const [modalOpen, setModalOpen] = useState(false);
  const [modalWidth, setModalWidth] = useState(500);
  const [modalHeight, setModalHeight] = useState(520);
  const [editingBookmark, setEditingBookmark] = useState<DbBookmark | null>(null);
  const [modalName, setModalName] = useState("");
  const [modalRemarks, setModalRemarks] = useState("");
  const [modalTags, setModalTags] = useState("");
  const [modalSql, setModalSql] = useState("");

  const handleModalResizeStart = (e: React.MouseEvent) => {
    e.preventDefault();
    const startX = e.clientX;
    const startY = e.clientY;
    const startWidth = modalWidth;
    const startHeight = modalHeight;

    const handleMouseMove = (moveEvent: MouseEvent) => {
      const deltaX = moveEvent.clientX - startX;
      const deltaY = moveEvent.clientY - startY;
      setModalWidth(Math.max(380, startWidth + deltaX));
      setModalHeight(Math.max(400, startHeight + deltaY));
    };

    const handleMouseUp = () => {
      document.removeEventListener("mousemove", handleMouseMove);
      document.removeEventListener("mouseup", handleMouseUp);
    };

    document.addEventListener("mousemove", handleMouseMove);
    document.addEventListener("mouseup", handleMouseUp);
  };

  // Listen for Escape and Ctrl+Enter / Cmd+Enter inside the modal
  useEffect(() => {
    if (!modalOpen) return;
    const handleModalKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setModalOpen(false);
      }
      if ((e.ctrlKey || e.metaKey) && e.key === "Enter") {
        e.preventDefault();
        const form = document.getElementById("bookmark-form") as HTMLFormElement | null;
        if (form) {
          form.requestSubmit();
        }
      }
    };
    window.addEventListener("keydown", handleModalKeyDown);
    return () => window.removeEventListener("keydown", handleModalKeyDown);
  }, [modalOpen]);

  const { show: openMenu, render: menu } = useContextMenu();

  // Load Bookmarks from DB
  const loadBookmarks = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const list = await dbListBookmarks(engine);
      setBookmarks(list);
    } catch (err) {
      setError(String(err));
    } finally {
      setLoading(false);
    }
  }, [engine]);

  useEffect(() => {
    void loadBookmarks();
  }, [loadBookmarks]);

  // Hook up external triggers (e.g. from editor toolbar)
  useEffect(() => {
    if (onAddTriggerRef) {
      onAddTriggerRef.current = () => {
        setEditingBookmark(null);
        setModalName("");
        setModalRemarks("");
        setModalTags("");
        setModalSql(activeSql || "");
        setModalOpen(true);
      };
    }
    return () => {
      if (onAddTriggerRef) {
        onAddTriggerRef.current = null;
      }
    };
  }, [onAddTriggerRef, activeSql]);

  // All unique tags compiled from bookmarks
  const allTags = useMemo(() => {
    const tagsSet = new Set<string>();
    bookmarks.forEach((b) => {
      b.tags.forEach((t) => {
        const clean = t.trim();
        if (clean) tagsSet.add(clean);
      });
    });
    return Array.from(tagsSet).sort();
  }, [bookmarks]);

  // Filter Bookmarks
  const filteredBookmarks = useMemo(() => {
    return bookmarks.filter((b) => {
      // 1. Search term match (name, sql, remarks, tags)
      if (searchTerm.trim()) {
        const term = searchTerm.toLowerCase();
        const matchesName = b.name.toLowerCase().includes(term);
        const matchesSql = b.sqlContent.toLowerCase().includes(term);
        const matchesRemarks = b.remarks?.toLowerCase().includes(term) ?? false;
        const matchesTags = b.tags.some((t) => t.toLowerCase().includes(term));
        if (!matchesName && !matchesSql && !matchesRemarks && !matchesTags) {
          return false;
        }
      }
      // 2. Selected tags match (must match all selected tags)
      if (selectedTags.length > 0) {
        const matchesAllTags = selectedTags.every((t) => b.tags.includes(t));
        if (!matchesAllTags) return false;
      }
      return true;
    });
  }, [bookmarks, searchTerm, selectedTags]);

  const handleToggleTagFilter = (tag: string) => {
    setSelectedTags((prev) =>
      prev.includes(tag) ? prev.filter((t) => t !== tag) : [...prev, tag]
    );
  };

  const handleOpenEdit = (bookmark: DbBookmark) => {
    setEditingBookmark(bookmark);
    setModalName(bookmark.name);
    setModalRemarks(bookmark.remarks ?? "");
    setModalTags(bookmark.tags.join(", "));
    setModalSql(bookmark.sqlContent);
    setModalOpen(true);
  };

  const handleDelete = async (id: string) => {
    if (confirm("Are you sure you want to delete this bookmark?")) {
      try {
        await dbDeleteBookmark(id);
        void loadBookmarks();
      } catch (err) {
        alert("Failed to delete bookmark: " + String(err));
      }
    }
  };

  const handleCopySql = (sql: string) => {
    navigator.clipboard.writeText(sql).catch(() => undefined);
  };

  const handleSave = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!modalName.trim()) return;

    const tagsArray = modalTags
      .split(",")
      .map((t) => t.trim())
      .filter((t) => t.length > 0);

    const now = Date.now();
    const bookmarkData: DbBookmark = {
      id: editingBookmark?.id ?? crypto.randomUUID(),
      name: modalName.trim(),
      sqlContent: modalSql,
      remarks: modalRemarks.trim() || undefined,
      tags: tagsArray,
      engine,
      databaseName: editingBookmark?.databaseName ?? activeDatabase ?? undefined,
      createdAt: editingBookmark?.createdAt ?? now,
      updatedAt: now,
    };

    try {
      await dbSaveBookmark(bookmarkData);
      setModalOpen(false);
      void loadBookmarks();
    } catch (err) {
      alert("Failed to save bookmark: " + String(err));
    }
  };

  const bookmarkMenu = (b: DbBookmark): MenuItem[] => [
    {
      label: "Run query",
      icon: <Play className="w-3.5 h-3.5" />,
      onClick: () => onRunBookmark(b.sqlContent),
    },
    {
      label: "Insert into editor",
      icon: <FolderOpen className="w-3.5 h-3.5" />,
      onClick: () => onSelectBookmark(b.sqlContent),
    },
    {
      label: "Copy SQL",
      icon: <Clipboard className="w-3.5 h-3.5" />,
      onClick: () => handleCopySql(b.sqlContent),
    },
    { label: "", separator: true },
    {
      label: "Edit...",
      icon: <Edit3 className="w-3.5 h-3.5" />,
      onClick: () => handleOpenEdit(b),
    },
    {
      label: "Delete",
      icon: <Trash2 className="w-3.5 h-3.5" />,
      danger: true,
      onClick: () => void handleDelete(b.id),
    },
  ];

  return (
    <div className="h-full flex flex-col min-h-0 bg-[var(--taomni-bg)] text-[var(--taomni-text)] text-[12px]">
      {/* Header & Controls */}
      <div className="p-2 border-b border-[var(--taomni-divider)] flex flex-col gap-2 shrink-0 bg-[var(--taomni-quick-bg)]">
        <div className="flex items-center gap-1.5">
          <div className="relative flex-1">
            <Search className="absolute left-2 top-[5px] w-3.5 h-3.5 text-[var(--taomni-text-muted)]" />
            <input
              type="search"
              placeholder="Search bookmarks..."
              className="taomni-input w-full h-6 text-[11px]"
              style={{ paddingLeft: "24px" }}
              value={searchTerm}
              onChange={(e) => setSearchTerm(e.target.value)}
            />
          </div>
          <button
            type="button"
            className="h-6 w-6 inline-flex items-center justify-center rounded hover:bg-[var(--taomni-hover)] border border-[var(--taomni-tab-border)]"
            title="Create new bookmark"
            onClick={() => {
              setEditingBookmark(null);
              setModalName("");
              setModalRemarks("");
              setModalTags("");
              setModalSql(activeSql || "");
              setModalOpen(true);
            }}
          >
            <Plus className="w-3.5 h-3.5" />
          </button>
        </div>

        {/* Tags filters */}
        {allTags.length > 0 && (
          <div className="flex flex-wrap gap-1 max-h-[60px] overflow-y-auto taomni-scroll-y py-0.5">
            {allTags.map((tag) => {
              const selected = selectedTags.includes(tag);
              return (
                <button
                  key={tag}
                  type="button"
                  onClick={() => handleToggleTagFilter(tag)}
                  className="px-1.5 py-0.5 rounded text-[10px] flex items-center gap-0.5 transition-colors border"
                  style={{
                    background: selected ? "var(--taomni-selected)" : "transparent",
                    borderColor: selected ? "var(--taomni-accent)" : "var(--taomni-divider)",
                    color: selected ? "var(--taomni-accent)" : "var(--taomni-text-muted)",
                  }}
                >
                  <Tag className="w-2.5 h-2.5" />
                  {tag}
                </button>
              );
            })}
          </div>
        )}
      </div>

      {/* Bookmarks List */}
      <div className="flex-1 overflow-y-auto taomni-scroll-y p-1">
        {loading ? (
          <div className="px-3 py-4 text-center text-[var(--taomni-text-muted)]">Loading bookmarks…</div>
        ) : error ? (
          <div className="px-3 py-4 text-center text-red-500">{error}</div>
        ) : filteredBookmarks.length === 0 ? (
          <div className="px-3 py-8 text-center text-[var(--taomni-text-muted)] flex flex-col items-center gap-2">
            <BookMarked className="w-8 h-8 opacity-40" />
            <span>
              {searchTerm || selectedTags.length > 0
                ? "No matching bookmarks found."
                : "No bookmarks yet. Click + or the star icon in the toolbar to save queries."}
            </span>
          </div>
        ) : (
          <div className="flex flex-col gap-0.5">
            {filteredBookmarks.map((b) => (
              <div
                key={b.id}
                className="group flex flex-col p-2 rounded cursor-pointer hover:bg-[var(--taomni-hover)] relative"
                onClick={() => onSelectBookmark(b.sqlContent)}
                onDoubleClick={() => onRunBookmark(b.sqlContent)}
                onContextMenu={(e) => openMenu(e, bookmarkMenu(b))}
                title={`Double click to run query.\n${b.remarks ? "Notes: " + b.remarks : ""}`}
              >
                {/* Title & Action */}
                <div className="flex items-start gap-1.5">
                  <Star className="w-3.5 h-3.5 text-[var(--taomni-accent)] mt-0.5 shrink-0" />
                  <div className="flex-1 min-w-0">
                    <span className="font-semibold text-[12px] truncate block text-[var(--taomni-text)]">
                      {b.name}
                    </span>
                    {/* Database label */}
                    {b.databaseName && (
                      <span className="text-[10px] text-[var(--taomni-text-muted)] italic block">
                        DB: {b.databaseName}
                      </span>
                    )}
                  </div>
                  <button
                    type="button"
                    className="opacity-0 group-hover:opacity-100 p-0.5 rounded hover:bg-[var(--taomni-divider)] shrink-0 transition-opacity"
                    onClick={(e) => {
                      e.stopPropagation();
                      openMenu(e, bookmarkMenu(b));
                    }}
                  >
                    <MoreVertical className="w-3.5 h-3.5 text-[var(--taomni-text-muted)]" />
                  </button>
                </div>

                {/* SQL preview */}
                <div className="taomni-mono text-[10px] text-[var(--taomni-text-muted)] truncate mt-1 bg-[color-mix(in_srgb,var(--taomni-hover)_40%,transparent)] px-1 rounded">
                  {b.sqlContent.replace(/\s+/g, " ")}
                </div>

                {/* Remarks preview if present */}
                {b.remarks && (
                  <div className="text-[10px] text-[var(--taomni-text-muted)] truncate mt-0.5 max-w-[240px]">
                    {b.remarks}
                  </div>
                )}

                {/* Tags */}
                {b.tags.length > 0 && (
                  <div className="flex flex-wrap gap-1 mt-1.5">
                    {b.tags.map((t) => (
                      <span
                        key={t}
                        className="px-1 rounded-[3px] text-[9px] bg-[var(--taomni-divider)] text-[var(--taomni-text-muted)] flex items-center gap-0.5"
                      >
                        <Tag className="w-2 h-2 shrink-0" />
                        {t}
                      </span>
                    ))}
                  </div>
                )}
              </div>
            ))}
          </div>
        )}
      </div>

      {menu}

      {/* Edit/Add Modal */}
      {modalOpen && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/40"
        >
          <div
            role="dialog"
            aria-modal="true"
            className="rounded shadow-lg p-4 flex flex-col gap-3 relative max-h-[90vh] max-w-[95vw] overflow-hidden"
            style={{
              width: modalWidth,
              height: modalHeight,
              background: "var(--taomni-bg)",
              border: "1px solid var(--taomni-card-border)",
            }}
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex justify-between items-center pb-2 border-b border-[var(--taomni-divider)] shrink-0">
              <span className="font-semibold text-[13px]">
                {editingBookmark ? "Edit Query Bookmark" : "Save SQL Bookmark"}
              </span>
              <button
                type="button"
                className="text-[var(--taomni-text-muted)] hover:text-[var(--taomni-text)]"
                onClick={() => setModalOpen(false)}
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            <form id="bookmark-form" onSubmit={handleSave} className="flex-1 flex flex-col gap-3 min-h-0">
              <div className="flex flex-col gap-0.5 shrink-0">
                <label className="text-[11px] text-[var(--taomni-text-muted)]">Name</label>
                <input
                  type="text"
                  required
                  placeholder="e.g. Get Active Users"
                  className="taomni-input h-7 w-full text-[12px] px-2"
                  value={modalName}
                  onChange={(e) => setModalName(e.target.value)}
                />
              </div>

              <div className="flex flex-col gap-0.5 shrink-0">
                <label className="text-[11px] text-[var(--taomni-text-muted)]">Remarks / Description</label>
                <textarea
                  placeholder="What is this SQL used for?"
                  className="taomni-input w-full text-[12px] p-1.5 h-12 resize-none taomni-scroll-y"
                  value={modalRemarks}
                  onChange={(e) => setModalRemarks(e.target.value)}
                />
              </div>

              <div className="flex flex-col gap-0.5 shrink-0">
                <label className="text-[11px] text-[var(--taomni-text-muted)]">
                  Tags (comma separated)
                </label>
                <input
                  type="text"
                  placeholder="e.g. auth, reporting, fix"
                  className="taomni-input h-7 w-full text-[12px] px-2"
                  value={modalTags}
                  onChange={(e) => setModalTags(e.target.value)}
                />
              </div>

              <div className="flex-1 flex flex-col gap-0.5 min-h-[100px]">
                <label className="text-[11px] text-[var(--taomni-text-muted)]">SQL Content</label>
                <textarea
                  readOnly={true}
                  className="taomni-input w-full text-[11px] taomni-mono p-2 bg-[var(--taomni-hover)] select-all cursor-text outline-none taomni-scroll-y flex-1"
                  style={{ resize: "none" }}
                  value={modalSql}
                />
              </div>

              <div className="flex items-center justify-end gap-2 mt-1 pt-2 border-t border-[var(--taomni-divider)] shrink-0">
                <button
                  type="button"
                  className="taomni-btn h-8 px-4 text-[12px]"
                  onClick={() => setModalOpen(false)}
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  className="taomni-btn h-8 px-4 text-[12px]"
                  style={{ background: "var(--taomni-accent)", color: "white" }}
                  disabled={!modalName.trim()}
                >
                  Save Bookmark
                </button>
              </div>
            </form>

            {/* Resize Handle */}
            <div
              className="absolute right-0 bottom-0 w-3.5 h-3.5 cursor-se-resize flex items-end justify-end p-0.5 select-none z-10"
              onMouseDown={handleModalResizeStart}
            >
              <svg width="6" height="6" viewBox="0 0 6 6" className="text-[var(--taomni-text-muted)] opacity-40 hover:opacity-80">
                <line x1="6" y1="0" x2="0" y2="6" stroke="currentColor" strokeWidth="1" />
                <line x1="6" y1="2" x2="2" y2="6" stroke="currentColor" strokeWidth="1" />
                <line x1="6" y1="4" x2="4" y2="6" stroke="currentColor" strokeWidth="1" />
              </svg>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
