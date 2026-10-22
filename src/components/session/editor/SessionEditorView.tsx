import { Bookmark, FileText, FlaskConical, Folder, HelpCircle, RotateCcw, Save, Terminal as TerminalIcon, Wifi, X } from "lucide-react";
import type { SessionConfig } from "../../../lib/ipc";
import { SESSION_ROOT_LABEL, folderOptionLabel } from "../../../lib/sessionPaths";
import { LocalShellOptionsForm } from "../forms/LocalShellOptionsForm";
import { WslOptionsForm } from "../forms/WslOptionsForm";
import { SessionConnectionFields } from "./SessionConnectionFields";
import { SessionEditorSections } from "./SessionEditorSections";
import { PLANNED_CLIENT_PROTOS, PROTOS } from "./sessionPolicy";
import { useSessionEditorActions } from "./useSessionEditorActions";
import { useSessionEditorNavigation } from "./useSessionEditorNavigation";
import { useSessionEditorState } from "./useSessionEditorState";


export interface SessionEditorViewProps {
  navigation: ReturnType<typeof useSessionEditorNavigation>;
  form: ReturnType<typeof useSessionEditorState>;
  onClose: () => void;
  actions: ReturnType<typeof useSessionEditorActions>;
  session: SessionConfig | undefined;
  shortcuts: { cancel: string; save: string; test: string; };
}

export function SessionEditorView(props: SessionEditorViewProps) {
  const { navigation, form, onClose, actions, session, shortcuts } = props;
  return ((
    <div
      className="fixed inset-0 z-50 flex items-center justify-center"
      style={{ background: "rgba(20,30,45,0.4)" }}
    >
      <div
        ref={navigation.containerRef}
        data-testid="session-editor"
        className="w-[1020px] max-w-[calc(100vw-24px)] max-h-[calc(100vh-24px)] flex flex-col rounded-[6px] shadow-2xl border overflow-hidden"
        style={{ background: "var(--taomni-panel-bg)", borderColor: "var(--taomni-chrome-border)", color: "var(--taomni-text)" }}
      >
        {/* Modal title bar */}
        <div
          ref={navigation.handleRef}
          className="h-7 flex items-center px-2 rounded-t-[5px] shrink-0 select-none"
          style={{
            background: "linear-gradient(to bottom,#5895c8,#2b5d8b)",
            color: "white",
          }}
        >
          <Bookmark className="w-3.5 h-3.5 mr-1.5" />
          <div className="text-[12px] font-semibold">
            {form.isEdit ? form.t("sessionEditor2.titleEdit") : form.t("sessionEditor2.titleNew")}
          </div>
          <div className="ml-auto flex items-center gap-2 text-[11px] opacity-95">
            <button
              data-testid="session-help"
              title={form.t("sessionEditor2.helpTitle")}
              className="hover:bg-white/15 rounded p-0.5"
              onClick={() => form.setTestResult({ ok: true, msg: form.t("sessionEditor2.helpMessage") })}
              type="button"
            >
              <HelpCircle className="w-3.5 h-3.5" />
            </button>
            <button
              data-testid="session-close"
              title={form.t("sessionEditor2.closeTitle")}
              className="hover:bg-red-500 rounded p-0.5"
              onClick={onClose}
              type="button"
            >
              <X className="w-3.5 h-3.5" />
            </button>
          </div>
        </div>

        {/* Protocol picker */}
        <div
          className="max-h-[min(210px,32vh)] overflow-y-auto overscroll-contain px-3 pt-3 pb-2 border-b shrink-0 taomni-scroll-y"
          style={{ borderColor: "var(--taomni-divider)" }}
        >
          <div className="flex flex-wrap gap-1">
            {PROTOS.map((p) => (
              <button
                key={p.id}
                data-testid={`session-proto-${p.id.toLowerCase()}`}
                className="taomni-proto-btn"
                data-active={form.proto === p.id}
                data-client-status={PLANNED_CLIENT_PROTOS.has(p.id) ? "planned" : "active"}
                title={PLANNED_CLIENT_PROTOS.has(p.id) ? form.t("sessionEditor2.plannedClientTitle", { proto: p.id }) : p.id}
                onClick={() => actions.handleProtoChange(p.id)}
                type="button"
              >
                <span
                  style={{
                    color: form.proto === p.id ? "var(--taomni-accent)" : p.color,
                  }}
                >
                  {p.icon}
                </span>
                <span>{p.id}</span>
              </button>
            ))}
          </div>
        </div>

        {/* Basic settings (blue header) */}
        {form.needsHost && !form.isMail && (
          <SessionConnectionFields
            t={form.t}
            proto={form.proto}
            host={form.host}
            setHost={form.setHost}
            handleHostPaste={actions.handleHostPaste}
            handleHostLookup={actions.handleHostLookup}
            specifyUser={form.specifyUser}
            setSpecifyUser={form.setSpecifyUser}
            username={form.username}
            setUsername={form.setUsername}
            port={form.port}
            setPort={form.setPort}
            isProxy={form.isProxy}
            isMail={form.isMail}
            password={form.password}
            passwordRef={form.passwordRef}
            setPassword={form.setPassword}
            setPasswordRef={form.setPasswordRef}
            vaultState={form.vaultState}
            saveInVault={form.saveInVault}
            setSaveInVault={form.setSaveInVault}
          />
        )}

        {form.isPlannedClient && (
          <div
            data-testid="session-planned-client-note"
            className="mx-4 mt-3 px-3 py-2 rounded border text-[12px]"
            style={{
              borderColor: "var(--taomni-input-border)",
              background: "var(--taomni-panel-bg)",
              color: "var(--taomni-text-muted)",
            }}
          >
            {form.t("sessionEditor2.plannedClientNote", { proto: form.proto })}
          </div>
        )}

        {/* Basic Serial settings — appears for the Serial protocol only */}
        {form.proto === "Serial" && (
          <div
            data-testid="session-serial-section"
            className="px-4 py-3 border-b shrink-0"
            style={{ borderColor: "var(--taomni-divider)", background: "var(--taomni-quick-bg)" }}
          >
            <div
              className="text-[12px] font-semibold mb-2 flex items-center gap-2"
              style={{ color: "var(--taomni-accent)" }}
            >
              <Wifi className="w-3.5 h-3.5" />
              {form.t("sessionEditor2.basicSerialTitle")}
            </div>
            <div className="grid grid-cols-12 gap-2 items-center">
              <label className="col-span-2 text-[12px] text-right" htmlFor="session-serial-device">
                {form.t("sessionEditor2.serialDeviceLabel")}
              </label>
              <input
                id="session-serial-device"
                data-testid="session-serial-device"
                className="taomni-input col-span-5"
                value={form.serialDevice}
                onChange={(e) => form.setSerialDevice(e.target.value)}
                aria-label={form.t("sessionEditor2.serialDeviceLabel")}
                placeholder={form.t("sessionEditor2.serialDevicePlaceholder")}
              />
              <label className="col-span-2 text-[12px] text-right" htmlFor="session-serial-baud">
                {form.t("sessionEditor2.serialBaudLabel")}
              </label>
              <input
                id="session-serial-baud"
                data-testid="session-serial-baud"
                className="taomni-input col-span-3"
                value={form.serialBaud}
                inputMode="numeric"
                onChange={(e) => form.setSerialBaud(e.target.value)}
                aria-label={form.t("sessionEditor2.serialBaudLabel")}
                placeholder="115200"
              />
              <div className="col-span-12 text-[11px] text-[var(--taomni-text-muted)]">
                {form.t("sessionEditor2.serialHint")}
              </div>
            </div>
          </div>
        )}

        {/* Basic File settings — appears for the File protocol only */}
        {form.proto === "File" && (
          <div
            className="px-4 py-3 border-b shrink-0"
            style={{ borderColor: "var(--taomni-divider)", background: "var(--taomni-quick-bg)" }}
          >
            <div
              className="text-[12px] font-semibold mb-2 flex items-center gap-2"
              style={{ color: "var(--taomni-accent)" }}
            >
              <FileText className="w-3.5 h-3.5" />
              {form.t("sessionEditor2.basicFileTitle")}
            </div>
            <div className="grid grid-cols-12 gap-2 items-center">
              <label className="col-span-2 text-[12px] text-right">
                {form.t("sessionEditor2.fileTargetLabel")}
              </label>
              <div className="col-span-10 flex items-center gap-1">
                <input
                  data-testid="session-file-target"
                  className="taomni-input flex-1"
                  value={form.host}
                  onChange={(e) => form.setHost(e.target.value)}
                  aria-label={form.t("sessionEditor2.fileTargetAria")}
                  placeholder={form.t("sessionEditor2.fileTargetPlaceholder")}
                />
                <button
                  title={form.t("sessionEditor2.browseFolder")}
                  className="taomni-btn px-2"
                  onClick={() => void actions.handleBrowseFolderTarget()}
                  type="button"
                >
                  <Folder className="w-3.5 h-3.5 inline -mt-0.5" />
                </button>
                <button
                  title={form.t("sessionEditor2.browseFile")}
                  className="taomni-btn px-2"
                  onClick={() => void actions.handleBrowseFileTarget()}
                  type="button"
                >
                  <FileText className="w-3.5 h-3.5 inline -mt-0.5" />
                </button>
              </div>
              <div className="col-span-12 text-[11px] text-[var(--taomni-text-muted)]">
                {form.t("sessionEditor2.fileTargetHint")}
              </div>
            </div>
          </div>
        )}

        {/* Basic Shell settings - appears for the local Shell protocol only */}
        {form.proto === "Shell" && (
          <div
            className="px-4 py-3 border-b shrink-0"
            style={{ borderColor: "var(--taomni-divider)", background: "var(--taomni-quick-bg)" }}
          >
            <div
              className="text-[12px] font-semibold mb-2 flex items-center gap-2"
              style={{ color: "var(--taomni-accent)" }}
            >
              <TerminalIcon className="w-3.5 h-3.5" />
              {form.t("sessionEditor2.localShellTitle")}
            </div>
            <LocalShellOptionsForm
              options={form.shellForm.localShellOptions}
              shells={form.shellForm.localShells}
              status={form.shellForm.localShellStatus}
              onChange={form.shellForm.setLocalShellOptions}
            />
          </div>
        )}

        {/* Basic WSL settings — appears for the WSL protocol only */}
        {form.proto === "WSL" && (
          <div
            data-testid="session-wsl-section"
            className="px-4 py-3 border-b shrink-0"
            style={{ borderColor: "var(--taomni-divider)", background: "var(--taomni-quick-bg)" }}
          >
            <div
              className="text-[12px] font-semibold mb-2 flex items-center gap-2"
              style={{ color: "var(--taomni-accent)" }}
            >
              <TerminalIcon className="w-3.5 h-3.5" />
              {form.t("wsl.options.title")}
            </div>
            <WslOptionsForm
              options={form.shellForm.wslOptions}
              distros={form.shellForm.wslDistros}
              status={form.shellForm.wslStatus}
              onChange={form.shellForm.setWslOptions}
            />
          </div>
        )}

        {/* Section tabs */}
        <div className="px-3 pt-2 flex shrink-0" style={{ background: "transparent" }}>
          {navigation.sectionTabs.map((t) => (
            <button
              key={t.id}
              data-testid={`session-section-${t.id}`}
              className="taomni-section-tab"
              data-active={navigation.activeSection === t.id}
              onClick={() => form.setSection(t.id)}
              type="button"
            >
              {t.icon}
              {t.label}
            </button>
          ))}
          <div className="flex-1 border-b" style={{ borderColor: "var(--taomni-input-border)" }} />
        </div>

        {/* Section body */}
        <SessionEditorSections
          navigation={navigation}
          form={form}
          actions={actions}
          session={session}
        />

        {/* Footer */}
        <div
          className="min-h-12 flex flex-wrap items-center gap-2 px-3 py-2 border-t shrink-0"
          style={{ background: "var(--taomni-quick-bg)", borderColor: "var(--taomni-divider)" }}
        >
          <div className="flex min-w-0 flex-1 flex-wrap items-center gap-2">
            {form.isSSH && form.needsHost && (
              <button
                className="taomni-btn shrink-0 flex items-center gap-1.5"
                data-testid="session-test-connection"
                onClick={actions.handleTestConnection}
                disabled={form.testing}
                type="button"
                aria-label={form.testing ? form.t("sessionEditor2.testing") : form.t("sessionEditor2.testConnection")}
              >
                <FlaskConical className="w-3.5 h-3.5" />
                {form.testing ? form.t("sessionEditor2.testing") : form.t("sessionEditor2.testConnection")}{shortcuts.test}
              </button>
            )}
            {form.isDb && (
              <button
                className="taomni-btn shrink-0 flex items-center gap-1.5"
                data-testid="db-test-connection"
                onClick={() => void actions.handleTestDbConnection()}
                disabled={form.testing}
                type="button"
                aria-label={form.testing ? form.t("sessionEditor2.testing") : form.t("sessionEditor2.testConnection")}
              >
                <FlaskConical className="w-3.5 h-3.5" />
                {form.testing ? form.t("sessionEditor2.testing") : form.t("sessionEditor2.testConnection")}{shortcuts.test}
              </button>
            )}
            {form.isHBase && (
              <button
                className="taomni-btn shrink-0 flex items-center gap-1.5"
                data-testid="hbase-test-connection"
                onClick={() => void actions.handleTestHBaseConnection()}
                disabled={form.testing}
                type="button"
                aria-label={form.testing ? form.t("sessionEditor2.testing") : form.t("sessionEditor2.testConnection")}
              >
                <FlaskConical className="w-3.5 h-3.5" />
                {form.testing ? form.t("sessionEditor2.testing") : form.t("sessionEditor2.testConnection")}{shortcuts.test}
              </button>
            )}
            {form.isProxy && (
              <button
                className="taomni-btn shrink-0 flex items-center gap-1.5"
                data-testid="proxy-test-connection"
                onClick={() => void actions.handleTestProxyConnection()}
                disabled={form.testing}
                type="button"
                aria-label={form.testing ? form.t("sessionEditor2.proxyTestTesting") : form.t("sessionEditor2.proxyTestBtn")}
              >
                <FlaskConical className="w-3.5 h-3.5" />
                {form.testing ? form.t("sessionEditor2.proxyTestTesting") : form.t("sessionEditor2.proxyTestBtn")}{shortcuts.test}
              </button>
            )}
            <button data-testid="session-save-template" className="taomni-btn shrink-0 flex items-center gap-1.5" type="button" onClick={() => void actions.handleSaveTemplate()}>
              <Save className="w-3.5 h-3.5" /> {form.t("sessionEditor2.saveTemplate")}
            </button>
            <button data-testid="session-reset" className="taomni-btn shrink-0 flex items-center gap-1.5" type="button" onClick={actions.handleReset}>
              <RotateCcw className="w-3.5 h-3.5" /> {form.t("sessionEditor2.reset")}
            </button>

            {(form.testResult || form.saveError) && (
              <span
                className="text-[11px] min-w-0 max-w-[280px] truncate"
                title={form.saveError ?? form.testResult?.msg}
                style={{ color: form.testResult?.ok && !form.saveError ? "#2f8a3e" : "#b22222" }}
                data-testid="session-test-result-summary"
              >
                {form.saveError ?? form.testResult?.msg}
              </span>
            )}

            <span
              className="min-w-0 basis-40 flex-1 truncate text-[11px] text-[var(--taomni-text-muted)]"
              title={`${form.t("sessionEditor2.willBeSavedTo")} ${form.groupPath ? folderOptionLabel(form.groupPath) : SESSION_ROOT_LABEL} / ${form.name || form.host || "..."}`}
            >
              {form.t("sessionEditor2.willBeSavedTo")}{" "}
              <span className="taomni-mono">
                {form.groupPath ? folderOptionLabel(form.groupPath) : SESSION_ROOT_LABEL} / {form.name || form.host || "..."}
              </span>
            </span>
          </div>

          <div className="ml-auto flex shrink-0 items-center gap-2">
            {form.isEdit && (
              <button
                data-testid="session-delete-editor"
                className="taomni-btn"
                onClick={actions.handleDelete}
                type="button"
                style={{ color: "#b22222" }}
              >
                {form.t("sessionEditor2.delete")}
              </button>
            )}
            <button
              data-testid="session-cancel"
              className="taomni-btn"
              onClick={onClose}
              type="button"
              aria-label={form.t("sessionEditor2.cancel")}
            >
              {form.t("sessionEditor2.cancel")}{shortcuts.cancel}
            </button>
            <button
              className="taomni-btn"
              data-testid="session-save"
              data-primary="true"
              onClick={actions.handleSave}
              type="button"
              aria-label={form.t("sessionEditor2.ok")}
            >
              {form.t("sessionEditor2.ok")}{shortcuts.save}
            </button>
          </div>
        </div>
      </div>
    </div>
  ));
}
