import { useEffect, useRef, useState } from "react";
import { ClipboardPaste, ImageUp } from "lucide-react";
import { useT } from "../../lib/i18n";
import { readFileBytes } from "../../lib/ipc";
import { NATIVE_FILE_DROP_EVENT, type NativeFileDropDetail } from "../../lib/osFileDrop";
import { errorText } from "../../lib/mfa/format";
import {
  NO_IMAGE,
  decodeImageFiles,
  imageFilesFromTransfer,
  isImageFile,
  pasteEventQrTexts,
  readClipboardQrTexts,
} from "../../lib/mfa/sources";

/** Outcome reported by the dialog after parsing decoded QR texts. */
export type MfaTextsOutcome = { ok: true } | { ok: false; message: string };

type PaneState = { kind: "idle" } | { kind: "busy" } | { kind: "error"; message: string };

function mimeFor(path: string): string {
  const ext = path.split(".").pop()?.toLowerCase();
  if (ext === "jpg" || ext === "jpeg") return "image/jpeg";
  if (ext === "gif" || ext === "webp" || ext === "bmp") return `image/${ext}`;
  return "image/png";
}

/** Screenshot import: paste, drop or choose an image containing a QR code. */
export function MfaImagePane({ onTexts }: { onTexts: (texts: string[]) => MfaTextsOutcome }) {
  const t = useT();
  const [state, setState] = useState<PaneState>({ kind: "idle" });
  const zoneRef = useRef<HTMLDivElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  const run = async (read: () => Promise<string[] | typeof NO_IMAGE>, noImageMessage: string) => {
    setState({ kind: "busy" });
    try {
      const texts = await read();
      if (texts === NO_IMAGE) {
        setState({ kind: "error", message: noImageMessage });
        return;
      }
      if (texts.length === 0) {
        setState({ kind: "error", message: t("mfa.imageNoQr") });
        return;
      }
      const outcome = onTexts(texts);
      setState(outcome.ok ? { kind: "idle" } : { kind: "error", message: outcome.message });
    } catch (err) {
      setState({ kind: "error", message: t("mfa.imageReadFailed", { error: errorText(err) }) });
    }
  };

  useEffect(() => {
    zoneRef.current?.focus();
  }, []);

  // Tauri delivers OS file drops as paths (see App.tsx dispatchNativeFileDrop).
  useEffect(() => {
    const onNativeDrop = (event: Event) => {
      const detail = (event as CustomEvent<NativeFileDropDetail>).detail;
      const rect = zoneRef.current?.getBoundingClientRect();
      if (!rect || detail.clientX < rect.left || detail.clientX > rect.right || detail.clientY < rect.top || detail.clientY > rect.bottom) return;
      const paths = detail.paths.filter((path) => isImageFile({ name: path }));
      if (paths.length === 0) return;
      void run(async () => {
        const blobs = await Promise.all(paths.map(async (path) => new Blob([Uint8Array.from(await readFileBytes(path))], { type: mimeFor(path) })));
        return decodeImageFiles(blobs);
      }, t("mfa.imageNoQr"));
    };
    window.addEventListener(NATIVE_FILE_DROP_EVENT, onNativeDrop);
    return () => window.removeEventListener(NATIVE_FILE_DROP_EVENT, onNativeDrop);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div className="space-y-3">
      <div
        ref={zoneRef}
        data-testid="mfa-image-dropzone"
        tabIndex={0}
        role="region"
        aria-label={t("mfa.imageHint")}
        className="flex min-h-[140px] flex-col items-center justify-center gap-2 rounded border-2 border-dashed p-4 text-center text-[12px] outline-none focus-visible:border-[var(--taomni-accent)]"
        style={{ borderColor: "var(--taomni-divider)", color: "var(--taomni-text-muted)" }}
        onPaste={(event) => {
          event.preventDefault();
          const transfer = event.clipboardData;
          void run(() => pasteEventQrTexts(transfer), t("mfa.imageNoClipboard"));
        }}
        onDragOver={(event) => {
          if (imageFilesFromTransfer(event.dataTransfer).length > 0 || event.dataTransfer.types.includes("Files")) event.preventDefault();
        }}
        onDrop={(event) => {
          const files = imageFilesFromTransfer(event.dataTransfer);
          if (files.length === 0) return;
          event.preventDefault();
          void run(() => decodeImageFiles(files), t("mfa.imageNoQr"));
        }}
      >
        <ImageUp className="h-6 w-6" />
        <span>{t("mfa.imageHint")}</span>
      </div>
      <div className="flex flex-wrap gap-2">
        <button
          type="button"
          data-testid="mfa-image-paste"
          className="inline-flex items-center gap-1 rounded border px-3 py-1 text-[12px] hover:bg-[var(--taomni-hover)]"
          style={{ borderColor: "var(--taomni-input-border)" }}
          disabled={state.kind === "busy"}
          onClick={() => void run(readClipboardQrTexts, t("mfa.imageNoClipboard"))}
        >
          <ClipboardPaste className="h-3.5 w-3.5" />
          {t("mfa.imagePaste")}
        </button>
        <button
          type="button"
          data-testid="mfa-image-choose"
          className="inline-flex items-center gap-1 rounded border px-3 py-1 text-[12px] hover:bg-[var(--taomni-hover)]"
          style={{ borderColor: "var(--taomni-input-border)" }}
          disabled={state.kind === "busy"}
          onClick={() => fileRef.current?.click()}
        >
          <ImageUp className="h-3.5 w-3.5" />
          {t("mfa.imageChoose")}
        </button>
        <input
          ref={fileRef}
          data-testid="mfa-image-file"
          type="file"
          accept="image/*"
          className="hidden"
          onChange={(event) => {
            const files = Array.from(event.target.files ?? []);
            event.target.value = "";
            if (files.length > 0) void run(() => decodeImageFiles(files), t("mfa.imageNoQr"));
          }}
        />
      </div>
      <div
        data-testid="mfa-image-status"
        data-state={state.kind}
        role="status"
        aria-live="polite"
        className="min-h-[18px] text-[12px]"
        style={{ color: state.kind === "error" ? "var(--taomni-error, #c33)" : "var(--taomni-text-muted)" }}
      >
        {state.kind === "busy" ? t("mfa.imageDecoding") : state.kind === "error" ? state.message : ""}
      </div>
    </div>
  );
}
