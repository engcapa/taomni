import { useState } from "react";
import { sessionCapabilities } from "../../../lib/sessionCapabilities";
import type { SessionBookmark } from "../../../lib/sessionBookmark";
import { Terminal as TerminalIcon, FolderPlus } from "lucide-react";
import { selectFilePath } from "../../../lib/ipc";
import { type TranslateFn } from "../../../lib/i18n";
import { type Proto } from "./sessionPolicy";
import { Field, Select, Checkbox } from "./Fields";


export function BookmarkSettings({
  value, onChange,
  t,
  name, setName,
  groupPath, setGroupPath,
  folderOptions,
  description, setDescription,
  tags, setTags,
  proto,
  onNewFolder,
  fileEmbedInTab, setFileEmbedInTab,
  fileExtraArgs, setFileExtraArgs,
  disableAiWrite, setDisableAiWrite,
}: {
  value: SessionBookmark;
  onChange: (value: SessionBookmark) => void;
  t: TranslateFn;
  name: string; setName: (v: string) => void;
  groupPath: string; setGroupPath: (v: string) => void;
  folderOptions: string[];
  description: string; setDescription: (v: string) => void;
  tags: string; setTags: (v: string) => void;
  proto: Proto;
  onNewFolder: () => void;
  fileEmbedInTab: boolean; setFileEmbedInTab: (v: boolean) => void;
  fileExtraArgs: string; setFileExtraArgs: (v: string) => void;
  disableAiWrite: boolean; setDisableAiWrite: (v: boolean) => void;
}) {
  const [iconPickerOpen, setIconPickerOpen] = useState(false);
  const capabilities = sessionCapabilities(proto);
  const { bgImage, bgOpacity, autoConnect, openNewWindow, reconnect, shortcut } = value;
  const patch = (change: Partial<SessionBookmark>) => onChange({ ...value, ...change });
  const setBgImage = (bgImage: string) => patch({ bgImage });
  const setBgOpacity = (bgOpacity: string) => patch({ bgOpacity });
  const setAutoConnect = (autoConnect: boolean) => patch({ autoConnect });
  const setOpenNewWindow = (openNewWindow: boolean) => patch({ openNewWindow });
  const setReconnect = (reconnect: boolean) => patch({ reconnect });
  const setShortcut = (shortcut: string) => patch({ shortcut });

  const handleBrowseBgImage = async () => {
    try {
      const selected = await selectFilePath(bgImage || undefined);
      if (selected) setBgImage(selected.trim());
    } catch (err) {
      alert("Failed to choose file: " + err);
    }
  };

  return (
    <div data-testid="bookmark-settings" className="grid grid-cols-12 gap-x-3 gap-y-2.5 text-[12px]">
      <Field label={t("sessionEditor2.fieldSessionName")}>
        <input
          data-testid="session-name"
          className="taomni-input w-72"
          value={name}
          aria-label={t("sessionEditor2.sessionNameAria")}
          onChange={(e) => setName(e.target.value)}
        />
        <span className="ml-2 text-[var(--taomni-text-muted)]">{t("sessionEditor2.sessionNameHint")}</span>
      </Field>

      <Field label={t("sessionEditor2.fieldSessionFolder")}>
        <Select
          dataTestId="session-folder-select"
          value={groupPath || "User sessions"}
          className="w-[260px]"
          options={folderOptions}
          onChange={(value) => setGroupPath(value === "User sessions" ? "" : value)}
        />
        <button data-testid="session-new-folder" className="taomni-btn ml-2 flex items-center gap-1" type="button" onClick={onNewFolder}>
          <FolderPlus className="w-3 h-3" /> {t("sessionEditor2.newFolderBtn")}
        </button>
      </Field>

      <Field label={t("sessionEditor2.fieldSessionIcon")}>
        <span
          className="inline-flex items-center gap-1 px-2 py-1 rounded border"
          style={{ borderColor: "var(--taomni-input-border)", background: "var(--taomni-input-bg)" }}
        >
          {value.customIcon ? <span>{value.customIcon}</span> : <TerminalIcon className="w-4 h-4" style={{ color: "#2b5d8b" }} />}
          {proto.toLowerCase()}
        </span>
        <button data-testid="session-custom-icon" className="taomni-btn ml-2" type="button" onClick={() => setIconPickerOpen((open) => !open)} aria-expanded={iconPickerOpen}>{t("sessionEditor2.customIconChange")}</button>
        {iconPickerOpen && <input className="taomni-input ml-2 w-32" aria-label={t("sessionEditor2.customIconAria")}
          maxLength={8} placeholder="★" value={value.customIcon}
          onChange={(event) => patch({ customIcon: event.target.value.trim() })} />}
      </Field>

      {capabilities.terminal && <Field label={t("sessionEditor2.fieldBackgroundImage")}>
        <input
          className="taomni-input flex-1"
          placeholder={t("sessionEditor2.backgroundImagePlaceholder")}
          value={bgImage}
          aria-label={t("sessionEditor2.backgroundImageAria")}
          onChange={(e) => setBgImage(e.target.value)}
        />
        <button
          data-testid="session-background-browse"
          className="taomni-btn ml-1"
          type="button"
          title={t("sessionEditor2.backgroundImageTitle")}
          onClick={handleBrowseBgImage}
        >
          {t("sessionEditor2.backgroundImageBrowse")}
        </button>
        <span className="ml-2 text-[var(--taomni-text-muted)]">{t("sessionEditor2.backgroundImageOpacity")}</span>
        <input
          className="taomni-input w-16 ml-1"
          value={bgOpacity}
          aria-label={t("sessionEditor2.backgroundOpacityAria")}
          onChange={(e) => setBgOpacity(e.target.value)}
        />
      </Field>}

      <Field label={t("sessionEditor2.fieldDescriptionNotes")}>
        <textarea
          className="taomni-input flex-1"
          style={{ height: 56, padding: 6 }}
          value={description}
          aria-label={t("sessionEditor2.descriptionAria")}
          onChange={(e) => setDescription(e.target.value)}
          placeholder={t("sessionEditor2.descriptionPlaceholder")}
        />
      </Field>

      <Field label={t("sessionEditor2.fieldTags")}>
        <input
          className="taomni-input flex-1"
          value={tags}
          aria-label={t("sessionEditor2.tagsAria")}
          onChange={(e) => setTags(e.target.value)}
          placeholder={t("sessionEditor2.tagsPlaceholder")}
        />
      </Field>

      <Field label={t("sessionEditor2.fieldAiSafety")}>
        <label className="flex items-center gap-1.5" data-testid="disable-ai-write-toggle">
          <Checkbox dataTestId="session-disable-ai-write" checked={disableAiWrite} onChange={setDisableAiWrite} />
          {t("sessionEditor2.disableAiWriteLabel")}
        </label>
        <span className="ml-2 text-[var(--taomni-text-muted)]">
          {t("sessionEditor2.disableAiWriteHint")}
        </span>
      </Field>

      {proto === "File" && (
        <>
          <Field label={t("sessionEditor2.fieldFileOptions")}>
            <label className="flex items-center gap-1.5">
              <Checkbox checked={fileEmbedInTab} onChange={setFileEmbedInTab} />
              {t("sessionEditor2.fileEmbedInTab")}
            </label>
          </Field>
          <Field label={t("sessionEditor2.fieldAdditionalParameters")}>
            <input
              className="taomni-input flex-1"
              value={fileExtraArgs}
              aria-label={t("sessionEditor2.additionalParametersAria")}
              onChange={(e) => setFileExtraArgs(e.target.value)}
              placeholder={t("sessionEditor2.additionalParametersPlaceholder")}
            />
          </Field>
        </>
      )}

      {proto !== "File" && proto !== "Proxy" && (
        <Field label={t("sessionEditor2.fieldStartupBehavior")}>
          <label className="flex items-center gap-1.5">
            <Checkbox dataTestId="session-auto-connect" checked={autoConnect} onChange={setAutoConnect} />
            {t("sessionEditor2.autoConnect")}
          </label>
          {capabilities.detachedWindow && <label className="ml-3 flex items-center gap-1.5">
            <Checkbox dataTestId="session-open-new-window" checked={openNewWindow} onChange={setOpenNewWindow} />
            {t("sessionEditor2.openNewWindow")}
          </label>}
          {proto === "SSH" && <label className="ml-3 flex items-center gap-1.5">
            <Checkbox dataTestId="session-reconnect" checked={reconnect} onChange={setReconnect} />
            {t("sessionEditor2.reconnectOnDisconnect")}
          </label>}
        </Field>
      )}

      {proto !== "Proxy" && <Field label={t("sessionEditor2.fieldKeyboardShortcut")}>
        <input
          className="taomni-input w-40"
          value={shortcut}
          aria-label={t("sessionEditor2.keyboardShortcutAria")}
          onChange={(e) => setShortcut(e.target.value)}
          placeholder={t("sessionEditor2.keyboardShortcutPlaceholder")}
        />
        <span className="ml-2 text-[var(--taomni-text-muted)]">
          {t("sessionEditor2.keyboardShortcutHint")}
        </span>
      </Field>}
    </div>
  );
}
