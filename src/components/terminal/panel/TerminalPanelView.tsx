import { Bot, ExternalLink, FolderOpen, Maximize2, Minimize2 } from "lucide-react";
import { WINDOWS_PRESET_COMMANDS } from "../../../lib/commonCommandsPresets";
import { submitSshAuthResponse } from "../../../lib/ipc";
import { FT_BUTTON_ACTIVE_OVERRIDE, FT_BUTTON_STYLE, FT_ICON_BUTTON_STYLE } from "../../floating-toolbar/floatingToolbarStyles";
import { ScreenshotMenuButton } from "../../screenshot/ScreenshotMenuButton";
import { MfaPrompt } from "../../session/MfaPrompt";
import { TabActions } from "../../tabbar/TabActionSlot";
import { AiRewriteOverlay } from "../AiRewriteOverlay";
import { CommonCommandsPalette } from "../CommonCommandsPalette";
import { SelectionToolbar } from "../SelectionToolbar";
import { ZmodemConflictDialog } from "../ZmodemConflictDialog";
import { CurrentTerminalSettingsDialog } from "./CurrentTerminalSettingsDialog";
import { formatZmodemBytes } from "./protocol";
import { useTerminalCommands } from "./useTerminalCommands";
import { useTerminalHighlights } from "./useTerminalHighlights";
import { useTerminalInteraction } from "./useTerminalInteraction";
import { useTerminalLifecycle } from "./useTerminalLifecycle";
import { useTerminalPanelState } from "./useTerminalPanelState";


export interface TerminalPanelViewProps {
  panel: ReturnType<typeof useTerminalPanelState>;
  activeForShortcuts: boolean;
  inputLocked: boolean;
  panelClasses: string;
  resolvedTheme: import("@xterm/xterm").ITheme;
  isMultiExecTarget: boolean | undefined;
  commands: ReturnType<typeof useTerminalCommands>;
  interaction: ReturnType<typeof useTerminalInteraction>;
  lifecycle: ReturnType<typeof useTerminalLifecycle>;
  sftpToggle: { open: boolean; onToggle: () => void; } | undefined;
  chatToggle: { open: boolean; onToggle: () => void; } | undefined;
  detachToggle: { onDetach: () => void; } | undefined;
  detachedWindowControls: import("./types").DetachedTerminalWindowControls | undefined;
  highlights: ReturnType<typeof useTerminalHighlights>;
  ssh: import("./types").SshConnectInfo | undefined;
}

export function TerminalPanelView(props: TerminalPanelViewProps) {
  const {
    panel,
    activeForShortcuts,
    inputLocked,
    panelClasses,
    resolvedTheme,
    isMultiExecTarget,
    commands,
    interaction,
    lifecycle,
    sftpToggle,
    chatToggle,
    detachToggle,
    detachedWindowControls,
    highlights,
    ssh,
  } = props;
  const { conflictDialogState, mfaPrompt } = panel;
  return ((
    <div
      ref={panel.panelRef}
      data-testid="terminal-pane"
      data-terminal-active={activeForShortcuts || undefined}
      data-input-locked={inputLocked || undefined}
      className={panelClasses}
      style={{
        background: resolvedTheme.background ?? "#1d1f21",
        ...(isMultiExecTarget ? { borderTop: "2px solid var(--taomni-accent)" } : {}),
      }}
      onWheel={(event) => {
        if (!event.ctrlKey) return;
        event.preventDefault();
        if (event.deltaY < 0) {
          commands.increaseFontSize();
        } else if (event.deltaY > 0) {
          commands.decreaseFontSize();
        }
      }}
      onDragOver={interaction.handleTerminalDragOver}
      onDrop={interaction.handleTerminalDrop}
      onContextMenu={lifecycle.handleTerminalContextMenu}
      onMouseDownCapture={lifecycle.handleTerminalMouseDownCapture}
      onMouseUpCapture={lifecycle.handleTerminalMouseUpCapture}
      onAuxClick={lifecycle.handleMiddleClick}
    >
      <div ref={panel.containerRef} className="terminal-host w-full h-full overflow-hidden" />

      <TabActions active={activeForShortcuts}>
        {sftpToggle && (
          <button
            type="button"
            data-testid="attached-sftp-toggle"
            onClick={sftpToggle.onToggle}
            title={sftpToggle.open ? panel.t("terminal.sftpFloatingClose") : panel.t("terminal.sftpFloatingOpen")}
            style={{
              ...FT_BUTTON_STYLE,
              ...(sftpToggle.open ? FT_BUTTON_ACTIVE_OVERRIDE : {}),
            }}
          >
            <FolderOpen size={14} />
            {panel.t("terminal.sftpFloatingButtonLabel")}
          </button>
        )}
        {chatToggle && (
          <button
            type="button"
            data-testid="tab-chat-toggle"
            aria-label={chatToggle.open ? panel.t("terminal.chatFloatingLabelClose") : panel.t("terminal.chatFloatingLabelOpen")}
            onClick={chatToggle.onToggle}
            title={chatToggle.open ? panel.t("terminal.chatFloatingTitleClose") : panel.t("terminal.chatFloatingTitleOpen")}
            style={{
              ...FT_BUTTON_STYLE,
              ...(chatToggle.open ? FT_BUTTON_ACTIVE_OVERRIDE : {}),
            }}
          >
            <Bot size={14} />
            {panel.t("terminal.chatFloatingButtonLabel")}
          </button>
        )}
        {detachToggle && (
          <button
            type="button"
            data-testid="terminal-detach"
            aria-label={panel.t("rdp.detach")}
            title={panel.t("rdp.detach")}
            onClick={detachToggle.onDetach}
            style={FT_ICON_BUTTON_STYLE}
          >
            <ExternalLink size={14} />
          </button>
        )}

        {detachedWindowControls && (
          <>
            <ScreenshotMenuButton />
            <button
              type="button"
              data-testid="detached-reattach"
              aria-label={panel.t("rdp.reattach")}
              title={panel.t("rdp.reattach")}
              onClick={() => {
                panel.preserveSessionOnUnmountRef.current = true;
                detachedWindowControls.onReattach(interaction.collectReattachState());
              }}
              style={FT_BUTTON_STYLE}
            >
              <ExternalLink size={14} />
              <span>{panel.t("rdp.reattach")}</span>
            </button>
            <button
              type="button"
              data-testid="detached-os-fullscreen"
              aria-label={panel.t("rdp.osFullscreen")}
              title={panel.t("rdp.osFullscreen")}
              onClick={detachedWindowControls.onToggleOsFullscreen}
              style={FT_ICON_BUTTON_STYLE}
            >
              {detachedWindowControls.osFullscreen ? <Minimize2 size={14} /> : <Maximize2 size={14} />}
            </button>
          </>
        )}
      </TabActions>

      {isMultiExecTarget && (
        <div
          className="absolute top-1 left-1 z-40 px-1.5 py-0.5 rounded pointer-events-none"
          style={{ background: "var(--taomni-accent)", color: "#fff", opacity: 0.85, fontSize: 10, fontWeight: 600 }}
        >
          ⊕ {panel.t("terminal.multiExecBadge")}
        </div>
      )}

      {highlights.keywordHighlights.length > 0 && (
        <div className="absolute inset-0 z-20 pointer-events-none">
          {highlights.keywordHighlights.map((highlight) => (
            <div
              key={`kw-${highlight.row}-${highlight.col}-${highlight.kind}`}
              className={`terminal-keyword-hit terminal-keyword-${highlight.kind}`}
              style={{
                left: highlight.left,
                top: highlight.top,
                width: highlight.width,
                height: highlight.height,
              }}
            />
          ))}
        </div>
      )}

      {highlights.searchHighlights.length > 0 && (
        <div className="absolute inset-0 z-30 pointer-events-none">
          {highlights.searchHighlights.map((highlight) => (
            <div
              key={`${highlight.row}-${highlight.col}-${highlight.active ? "active" : "match"}`}
              className={highlight.active ? "terminal-search-hit terminal-search-hit-active" : "terminal-search-hit"}
              style={{
                left: highlight.left,
                top: highlight.top,
                width: highlight.width,
                height: highlight.height,
              }}
            />
          ))}
        </div>
      )}

      {highlights.blockSelectionHighlights.length > 0 && (
        <div className="absolute inset-0 z-[35] pointer-events-none">
          {highlights.blockSelectionHighlights.map((highlight) => (
            <div
              key={`block-${highlight.row}`}
              className="terminal-block-selection"
              style={{
                left: highlight.left,
                top: highlight.top,
                width: highlight.width,
                height: highlight.height,
              }}
            />
          ))}
        </div>
      )}

      {highlights.inlineGhost && (
        <div
          className="terminal-inline-ghost"
          aria-hidden
          style={{
            left: highlights.inlineGhost.left,
            top: highlights.inlineGhost.top,
            height: highlights.inlineGhost.height,
            maxWidth: highlights.inlineGhost.maxWidth,
            fontFamily: panel.fontFamily,
            fontSize: panel.fontSize,
            lineHeight: `${highlights.inlineGhost.height}px`,
            color: resolvedTheme.foreground ?? "#eaeaea",
          }}
        >
          {highlights.inlineGhost.text}
        </div>
      )}

      {lifecycle.effectiveReadOnly && (
        <div
          data-testid={inputLocked ? "terminal-input-locked" : "terminal-read-only"}
          className="absolute right-3 bottom-3 z-40 px-2 py-1 rounded border bg-white/90 text-[11px] text-slate-700 shadow-sm pointer-events-none"
        >
          {inputLocked ? panel.t("terminal.inputLocked") : panel.t("terminal.readOnlyBadge")}
        </div>
      )}

      {interaction.searchOpen && (
        <div
          className="absolute right-3 top-3 z-50 flex items-center gap-1 rounded border border-slate-400 bg-white p-1 shadow-lg text-[12px]"
          onMouseDown={(event) => event.stopPropagation()}
          onClick={(event) => event.stopPropagation()}
          onContextMenu={(event) => event.stopPropagation()}
        >
          <input
            ref={panel.searchInputRef}
            className="taomni-input h-7 w-56"
            value={interaction.searchValue}
            placeholder={panel.t("terminal.findPlaceholder")}
            onChange={(event) => {
              const next = event.target.value;
              interaction.setSearchValue(next);
              interaction.fallbackSearchRef.current = { query: next.trim(), index: -1 };
              interaction.setSearchStatus("");
            }}
            onKeyDown={(event) => {
              if (event.key === "Escape") {
                event.preventDefault();
                interaction.closeSearch();
              } else if (event.key === "Enter") {
                event.preventDefault();
                interaction.runSearch(event.shiftKey ? "previous" : "next");
              }
            }}
          />
          <button className="taomni-btn h-7 px-2" type="button" onClick={() => interaction.runSearch("previous")}>
            {panel.t("terminal.findPrev")}
          </button>
          <button className="taomni-btn h-7 px-2" type="button" onClick={() => interaction.runSearch("next")}>
            {panel.t("terminal.findNext")}
          </button>
          <button className="taomni-btn h-7 px-2" type="button" onClick={interaction.closeSearch}>
            {panel.t("terminal.findClose")}
          </button>
          {interaction.searchStatus && <span className="px-1 text-[11px] text-[#b22222]">{interaction.searchStatus}</span>}
        </div>
      )}

      {panel.eventLogOpen && (
        <div
          data-testid="terminal-event-log"
          className="absolute right-4 bottom-4 z-50 w-[520px] max-w-[calc(100%-2rem)] max-h-[360px] rounded border border-slate-500 bg-white shadow-xl text-[12px] overflow-hidden"
          onMouseDown={(event) => event.stopPropagation()}
          onClick={(event) => event.stopPropagation()}
          onContextMenu={(event) => event.stopPropagation()}
        >
          <div className="h-8 flex items-center px-3 border-b bg-slate-100">
            <span className="font-semibold">{panel.t("terminal.eventLogTitle")}</span>
            <button
              data-testid="terminal-event-log-close"
              className="taomni-btn ml-auto h-6 px-2"
              type="button"
              onClick={() => panel.setEventLogOpen(false)}
            >
              {panel.t("terminal.eventLogClose")}
            </button>
          </div>
          <div className="max-h-[320px] overflow-auto">
            {panel.eventLog.length === 0 ? (
              <div className="p-3 text-slate-500">{panel.t("terminal.eventLogEmpty")}</div>
            ) : (
              <table className="w-full border-collapse">
                <tbody>
                  {panel.eventLog.map((entry) => (
                    <tr key={entry.id} className="border-b border-slate-100">
                      <td className="w-20 px-2 py-1 text-slate-500 taomni-mono">{entry.time}</td>
                      <td className="w-24 px-2 py-1 font-semibold">{entry.type}</td>
                      <td className="px-2 py-1">{entry.detail}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        </div>
      )}

      {panel.zmodemState !== "idle" && (
        <div className="absolute left-1/2 top-4 z-50 -translate-x-1/2 flex items-center gap-3 rounded border border-slate-400 bg-white px-4 py-2 shadow-lg text-[12px]">
          <span className="font-semibold">
            {panel.zmodemState === "receiving" ? panel.t("terminal.zmodemReceiving") : panel.t("terminal.zmodemSending")} {panel.t("terminal.zmodemViaZmodem")}
          </span>
          {panel.zmodemProgress && (
            <>
              <span className="text-slate-600 taomni-mono">{panel.zmodemProgress.fileName}</span>
              <span className="text-slate-500">
                {formatZmodemBytes(panel.zmodemProgress.bytesTransferred)}
                {panel.zmodemProgress.fileSize > 0 && ` / ${formatZmodemBytes(panel.zmodemProgress.fileSize)}`}
              </span>
              {panel.zmodemProgress.fileSize > 0 && (
                <div className="w-32 h-2 rounded bg-slate-200 overflow-hidden">
                  <div
                    className="h-full bg-blue-500 transition-all"
                    style={{ width: `${Math.min(100, Math.round(panel.zmodemProgress.bytesTransferred / panel.zmodemProgress.fileSize * 100))}%` }}
                  />
                </div>
              )}
            </>
          )}
        </div>
      )}

      {panel.contextMenu.render}
      {panel.pasteConfirmDialog}
      {panel.terminalDefaultsConfirmDialog}

      {panel.settingsDialogOpen && (
        <CurrentTerminalSettingsDialog
          profile={panel.currentTerminalProfileRef.current}
          onProfileChange={panel.commitTerminalProfilePatch}
          onSaveAsDefault={() => {
            void commands.saveCurrentProfileAsTerminalDefault();
          }}
          onClose={() => {
            panel.setSettingsDialogOpen(false);
            interaction.focusTerminal();
          }}
        />
      )}

      {conflictDialogState && (
        <ZmodemConflictDialog
          fileName={conflictDialogState.fileName}
          hasMore={conflictDialogState.hasMore}
          mode={conflictDialogState.mode}
          onResolve={(action) => {
            panel.setConflictDialogState(null);
            conflictDialogState.resolve(action);
          }}
        />
      )}

      {mfaPrompt && (
        <MfaPrompt
          host={ssh?.host ?? ""}
          username={ssh?.username ?? ""}
          request={mfaPrompt}
          onSubmit={(responses) => {
            void submitSshAuthResponse(mfaPrompt.requestId, responses).catch(() => { });
            panel.pendingMfaRequestIdRef.current = null;
            panel.setMfaPrompt(null);
            interaction.focusTerminal();
          }}
          onCancel={() => {
            void submitSshAuthResponse(mfaPrompt.requestId, null).catch(() => { });
            panel.pendingMfaRequestIdRef.current = null;
            panel.setMfaPrompt(null);
          }}
        />
      )}

      {panel.isLocal && panel.supportsShellTools && (
        <CommonCommandsPalette
          open={panel.paletteOpen}
          historyHostKey={interaction.historyHostKey}
          userCommands={panel.commonCommands}
          presets={WINDOWS_PRESET_COMMANDS}
          onPick={(cmd) => {
            panel.setPaletteOpen(false);
            interaction.sendTerminalInput(cmd);
            interaction.focusTerminal();
          }}
          onClose={() => {
            panel.setPaletteOpen(false);
            interaction.focusTerminal();
          }}
        />
      )}

      {panel.supportsShellTools && panel.aiRewriteOpen && !interaction.isLocalPowerShell && (
        <AiRewriteOverlay
          currentCommand={interaction.pendingRef.current}
          onAccept={(newCmd) => {
            panel.setAiRewriteOpen(false);
            // Clear the current pending input and inject the rewritten command.
            // Send backspaces to clear the line, then inject the new command.
            const clearLine = "\x15"; // Ctrl+U clears the line in most shells
            interaction.sendTerminalInput(clearLine + newCmd);
            interaction.pendingRef.current = newCmd;
            interaction.invalidatedRef.current = false;
            interaction.refreshSuggestion();
            interaction.focusTerminal();
          }}
          onDismiss={() => {
            panel.setAiRewriteOpen(false);
            interaction.focusTerminal();
          }}
        />
      )}

      <SelectionToolbar
        visible={!!panel.selectionToolbar}
        rect={panel.selectionToolbar?.rect ?? null}
        selectionText={panel.selectionToolbar?.text ?? ""}
        onCopy={(text) => {
          void interaction.writeClipboardText(text, "");
          panel.setSelectionToolbar(null);
        }}
        onSendToAi={(text) => {
          void panel.attachToComposer(text);
          panel.setSelectionToolbar(null);
        }}
        onExplain={(text) => {
          void panel.explainSelection(text);
          panel.setSelectionToolbar(null);
        }}
        onDismiss={() => panel.setSelectionToolbar(null)}
      />
    </div>
  ));
}
