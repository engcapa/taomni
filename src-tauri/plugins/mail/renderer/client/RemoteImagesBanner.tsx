import { ImageOff } from "lucide-react";


export function RemoteImagesBanner({
  visible,
  allowRemoteImages,
  onAllowThisMessage,
  onAllowAllInTab,
  onBlock,
}: {
  visible: boolean;
  allowRemoteImages: boolean;
  onAllowThisMessage: () => void;
  onAllowAllInTab: () => void;
  onBlock: () => void;
}) {
  if (!visible) return null;
  return (
    <div
      className="mx-4 mt-3 mb-0 flex flex-wrap items-center gap-2 rounded border border-[var(--taomni-divider)] bg-[var(--taomni-sidebar-bg)] px-3 py-2 text-[12px]"
      data-testid="mail-remote-images-banner"
    >
      <ImageOff className="w-3.5 h-3.5 shrink-0 text-[var(--taomni-text-muted)]" />
      <span className="flex-1 text-[var(--taomni-text-muted)]">
        {allowRemoteImages
          ? "Remote images are shown for this message."
          : "To protect your privacy, remote images in this message have been blocked."}
      </span>
      {allowRemoteImages ? (
        <button
          type="button"
          className="taomni-btn h-6 px-2 text-[11px]"
          data-testid="mail-remote-images-toggle"
          onClick={onBlock}
        >
          Block remote content
        </button>
      ) : (
        <>
          <button
            type="button"
            className="taomni-btn h-6 px-2 text-[11px]"
            data-testid="mail-remote-images-toggle"
            onClick={onAllowThisMessage}
          >
            Show for this message
          </button>
          <button
            type="button"
            className="taomni-btn h-6 px-2 text-[11px]"
            data-testid="mail-remote-images-allow-all"
            onClick={onAllowAllInTab}
            title="Allow remote images for all messages in this tab until closed"
          >
            Allow all in tab
          </button>
        </>
      )}
    </div>
  );
}
