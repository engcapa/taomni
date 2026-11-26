import { useEffect, useRef, useState } from "react";
import { RefreshCw, Trash2 } from "lucide-react";
import { useT } from "../../lib/i18n";
import { formatUnknownError, useAppDialogs } from "../../lib/appDialogs";
import { listScreenshotFavorites, loadFavoriteThumbnail, pinScreenshotFavorite, removeScreenshotFavorite, revokeScreenshotUrl, type ScreenshotFavorite } from "../../lib/screenshot";
import { IconButton } from "../ui/IconButton";
import { Modal } from "../ui/Modal";

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
    : <div className="h-28 flex items-center justify-center text-ui-body text-[var(--taomni-text-muted)]">{t(failed ? "screenshot.pinLoadFailed" : "screenshot.favoritesLoading")}</div>;
}

export function ScreenshotFavorites({ onClose, returnFocus }: { onClose: () => void; returnFocus?: HTMLElement | null }) {
  const t = useT();
  const dialogs = useAppDialogs();
  const [items, setItems] = useState<ScreenshotFavorite[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [revision, setRevision] = useState(0);
  const removing = useRef(false);
  useEffect(() => {
    let active = true;
    setLoading(true);
    setError(null);
    listScreenshotFavorites().then((value) => { if (active) setItems(value); })
      .catch((e) => { if (active) setError(formatUnknownError(e)); })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [revision]);
  const open = async (id: string) => {
    if (busyId) return;
    setBusyId(id); setError(null);
    try { await pinScreenshotFavorite(id); }
    catch (e) { setError(formatUnknownError(e)); }
    finally { setBusyId(null); }
  };
  const remove = async (id: string) => {
    if (busyId || removing.current) return;
    removing.current = true;
    try {
      if (!await dialogs.confirm({
        title: t("screenshot.favoriteRemove"),
        message: t("screenshot.favoriteRemoveConfirm"),
        confirmLabel: t("screenshot.favoriteRemove"),
        danger: true,
      })) return;
      setBusyId(id);
      setError(null);
      await removeScreenshotFavorite(id);
      setItems((current) => current.filter((item) => item.id !== id));
    } catch (e) {
      setError(formatUnknownError(e));
    } finally {
      removing.current = false;
      setBusyId(null);
    }
  };
  return <Modal title={t("screenshot.favorites")} testId="screenshot-favorites" size="wide"
    initialFocus='[data-testid="screenshot-favorites-close"]' returnFocus={returnFocus}
    dismissOnBackdrop onCancel={onClose} footer={<>
      <IconButton data-testid="screenshot-favorites-refresh" label={t("screenshot.favoritesRefresh")}
        disabled={loading || !!busyId} onClick={() => setRevision((v) => v + 1)} className="taomni-btn px-2"><RefreshCw size={14} /></IconButton>
      <button type="button" className="taomni-btn" data-testid="screenshot-favorites-close" onClick={onClose}>{t("common.close")}</button>
    </>}>
      <p className="mb-3 text-[var(--taomni-text-muted)]">{t("screenshot.favoritesHint")}</p>
      {error && <p data-testid="screenshot-favorites-error" role="alert" className="mb-3 text-ui-danger">{error}</p>}
      <div>
        {loading ? <p role="status" className="text-ui-body">{t("screenshot.favoritesLoading")}</p> : items.length === 0 ? <p data-testid="screenshot-favorites-empty" className="py-8 text-center text-ui-body text-[var(--taomni-text-muted)]">{t("screenshot.favoritesEmpty")}</p> : <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
          {items.map((item) => <div key={item.id} data-testid="screenshot-favorite-item" className="rounded-lg p-2 border border-[var(--taomni-divider)]">
            <FavoriteThumbnail item={item} />
            {item.note ? <p data-testid="screenshot-favorite-note" title={item.note} className="mt-2 text-ui-body leading-4 line-clamp-2 break-words">{item.note}</p> : null}
            <p className="mt-2 text-ui-small text-[var(--taomni-text-muted)]">{new Date(item.createdAt).toLocaleString()}</p>
            <div className="flex items-center gap-1 mt-2 text-ui-body">
              <span className="flex-1 tabular-nums">{item.width} × {item.height}</span>
              <button type="button" data-testid="screenshot-favorite-open" disabled={!!busyId} onClick={() => void open(item.id)} className="taomni-btn" data-primary="true">{t("screenshot.pin")}</button>
              <IconButton data-testid="screenshot-favorite-remove" disabled={!!busyId} label={t("screenshot.favoriteRemove")} onClick={() => void remove(item.id)} className="taomni-btn px-2" data-variant="ghost"><Trash2 size={14} /></IconButton>
            </div>
          </div>)}
        </div>}
      </div>
  </Modal>;
}
