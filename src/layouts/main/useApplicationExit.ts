import { useEffect, useCallback } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import type { Tab } from "../../types";
import { exitApp } from "../../lib/ipc";
import { listQueryTabs } from "../../lib/queryRegistry";
import { t as tr } from "../../lib/i18n";
import { saveBackupSettingsBeforeExit } from "../../stores/backupSettingsStore";


export interface UseApplicationExitContext {
  tabsRef: import("react").RefObject<Tab[]>;
  confirmAppExit: (options: import("../../components/sidebar/ConfirmDialog").ConfirmDialogOptions) => Promise<boolean>;
  exitRequestInFlightRef: import("react").RefObject<boolean>;
}

export function useApplicationExit(context: UseApplicationExitContext) {
  const { tabsRef, confirmAppExit, exitRequestInFlightRef } = context;

  const confirmExitWithOpenTabs = useCallback(async () => {
    const currentTabs = tabsRef.current;
    const terminalCount = currentTabs.filter((tab) => tab.type === "terminal" && tab.closable).length;
    const tabCount = currentTabs.filter((tab) => tab.closable).length;
    if (tabCount === 0) return true;

    const isOne = tabCount === 1;
    let message: string;
    if (terminalCount > 0) {
      message = tr(isOne ? "exit.promptOneTerminal" : "exit.promptManyTerminals", {
        count: tabCount,
        terminals: terminalCount,
      });
    } else {
      message = tr(isOne ? "exit.promptOne" : "exit.promptMany", { count: tabCount });
    }
    return confirmAppExit({
      title: tr("ribbon.exit"),
      message,
      confirmLabel: tr("ribbon.exit"),
      danger: true,
    });
  }, [confirmAppExit]);

  const requestAppExit = useCallback(() => {
    if (exitRequestInFlightRef.current) return;
    exitRequestInFlightRef.current = true;
    void (async () => {
      try {
        if (!(await confirmExitWithOpenTabs())) return;
        if (!await saveBackupSettingsBeforeExit(() => confirmAppExit({
          title: tr("backupUnified.unsavedTitle"),
          message: tr("backupUnified.unsavedExit"),
          confirmLabel: tr("backupUnified.retrySave"),
          cancelLabel: tr("exit.cancelExit"),
        }))) return;
        await Promise.allSettled(
          listQueryTabs().map((entry) => entry.flushWorkspace?.()),
        );
        for (;;) {
          try {
            await exitApp();
            return;
          } catch (error) {
            const retry = await confirmAppExit({
              title: tr("exit.cleanupFailedTitle"),
              message: tr("exit.cleanupFailedMessage", { error: String(error) }),
              confirmLabel: tr("exit.retryCleanup"),
              cancelLabel: tr("exit.cancelExit"),
              danger: true,
            });
            if (!retry) return;
          }
        }
      } finally {
        exitRequestInFlightRef.current = false;
      }
    })();
  }, [confirmAppExit, confirmExitWithOpenTabs]);

  useEffect(() => {
    const appWindow = getCurrentWindow();
    let unlisten: (() => void) | undefined;

    void appWindow.onCloseRequested((event) => {
      event.preventDefault();
      requestAppExit();
    }).then((fn) => {
      unlisten = fn;
    });

    return () => {
      unlisten?.();
    };
  }, [requestAppExit]);
  return { requestAppExit };
}
