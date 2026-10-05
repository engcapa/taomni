import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { RefreshCw, Trash2, X } from "lucide-react";
import { useT } from "../../lib/i18n";
import { formatUnknownError, useAppDialogs } from "../../lib/appDialogs";
import { listScreenshotFavorites, loadFavoriteThumbnail, pinScreenshotFavorite, removeScreenshotFavorite, revokeScreenshotUrl, type ScreenshotFavorite } from "../../lib/screenshot";

function FavoriteThumbnail({ item }: { item: ScreenshotFavorite }) {
  const [url, setUrl] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  const t = useT();
  useEffect(() => {
    let active = true;
    let loaded: string | null = null;
    loadFavoriteThumbnail(item.id).then((value) => {
      loaded = value;
      if (active) setUrl(value); else revokeScreenshotUrl(value);
    }).catch(() => { if (active) setFailed(true); });
    return () => { active = false; revokeScreenshotUrl(loaded); };
  }, [item.id]);
  return url ? <img data-testid="screenshot-favorite-thumbnail" src={url} alt={t("screenshot.pin")} className="w-full h-28 object-contain rounded bg-black/10" />
    : <div className="h-28 flex items-center justify-center text-[12px] text-[var(--taomni-text-muted)]">{t(failed ? "screenshot.pinLoadFailed" : "screenshot.favoritesLoading")}</div>;
}

export function ScreenshotFavorites({ onClose }: { onClose: () => void }) {
  const t = useT();
  const dialogs = useAppDialogs();
  const [items, setItems] = useState<ScreenshotFavorite[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [revision, setRevision] = useState(0);
  useEffect(() => {
    let active = true;
    setLoading(true);
    setError(null);
    listScreenshotFavorites().then((value) => { if (active) setItems(value); })
      .catch((e) => { if (active) setError(formatUnknownError(e)); })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [revision]);
  useEffect(() => {
    const key = (e: KeyboardEvent) => { if (e.key === "Escape") { e.stopPropagation(); onClose(); } };
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  }, [onClose]);
  const open = async (id: string) => {
    if (busyId) return;
    setBusyId(id); setError(null);
    try { await pinScreenshotFavorite(id); }
    catch (e) { setError(formatUnknownError(e)); }
    finally { setBusyId(null); }
  };
  const remove = async (id: string) => {
    if (busyId) return;
    if (!await dialogs.confirm({ title: t("screenshot.favoriteRemove"), message: t("screenshot.favoriteRemoveConfirm") })) return;
    setBusyId(id); setError(null);
    try { await removeScreenshotFavorite(id); setItems((current) => current.filter((item) => item.id !== id)); }
    catch (e) { setError(formatUnknownError(e)); }
    finally { setBusyId(null); }
  };
  return createPortal(<div className="fixed inset-0 z-[100] flex items-center justify-center bg-black/40" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
    <div data-testid="screenshot-favorites" role="dialog" aria-modal="true" aria-label={t("screenshot.favorites")} className="w-[640px] max-w-[calc(100vw-32px)] max-h-[80vh] flex flex-col rounded-xl border border-[var(--taomni-divider)] bg-[var(--taomni-panel-bg)] text-[var(--taomni-text)] shadow-2xl">
      <div className="flex items-center gap-2 border-b border-[var(--taomni-divider)] px-4 py-3">
        <h2 className="flex-1 text-[14px] font-medium">{t("screenshot.favorites")}</h2>
        <button data-testid="screenshot-favorites-refresh" aria-label={t("screenshot.favoritesRefresh")} title={t("screenshot.favoritesRefresh")} disabled={loading || !!busyId} onClick={() => setRevision((v) => v + 1)} className="p-1.5 rounded hover:bg-[var(--taomni-hover)]"><RefreshCw size={16} /></button>
        <button data-testid="screenshot-favorites-close" aria-label={t("screenshot.cancel")} onClick={onClose} className="p-1.5 rounded hover:bg-[var(--taomni-hover)]"><X size={16} /></button>
      </div>
      <p className="px-4 pt-3 text-[12px] text-[var(--taomni-text-muted)]">{t("screenshot.favoritesHint")}</p>
      {error && <p data-testid="screenshot-favorites-error" role="alert" className="px-4 pt-3 text-[12px] text-red-500">{error}</p>}
      <div className="overflow-auto p-4">
        {loading ? <p role="status" className="text-[12px]">{t("screenshot.favoritesLoading")}</p> : items.length === 0 ? <p data-testid="screenshot-favorites-empty" className="py-8 text-center text-[13px] text-[var(--taomni-text-muted)]">{t("screenshot.favoritesEmpty")}</p> : <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
          {items.map((item) => <div key={item.id} data-testid="screenshot-favorite-item" className="rounded-lg p-2 border border-[var(--taomni-divider)]">
            <FavoriteThumbnail item={item} />
            <p className="mt-2 text-[11px] text-[var(--taomni-text-muted)]">{new Date(item.createdAt).toLocaleString()}</p>
            <div className="flex items-center gap-1 mt-2 text-[12px]">
              <span className="flex-1 tabular-nums">{item.width} × {item.height}</span>
              <button data-testid="screenshot-favorite-open" disabled={!!busyId} onClick={() => void open(item.id)} className="rounded px-2 py-1 bg-[var(--taomni-accent)] text-white disabled:opacity-40">{t("screenshot.pin")}</button>
              <button data-testid="screenshot-favorite-remove" disabled={!!busyId} aria-label={t("screenshot.favoriteRemove")} title={t("screenshot.favoriteRemove")} onClick={() => void remove(item.id)} className="rounded p-1.5 hover:bg-[var(--taomni-hover)] disabled:opacity-40"><Trash2 size={14} /></button>
            </div>
          </div>)}
        </div>}
      </div>
    </div>
  </div>, document.body);
}
