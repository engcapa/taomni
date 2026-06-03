import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import {
  AlertDialog,
  ConfirmDialog,
  TextInputDialog,
  type ConfirmDialogOptions,
  type TextInputDialogOptions,
} from "../components/sidebar/ConfirmDialog";

export type AppConfirmDialogOptions = ConfirmDialogOptions;
export type AppPromptDialogOptions = TextInputDialogOptions;

export interface AppAlertDialogOptions {
  title?: string;
  message: string;
  okLabel?: string;
}

type DialogValue = boolean | string | null | undefined;

type PendingAppDialog =
  | ({ id: number; kind: "confirm"; resolve: (value: DialogValue) => void } & AppConfirmDialogOptions)
  | ({ id: number; kind: "prompt"; resolve: (value: DialogValue) => void } & AppPromptDialogOptions)
  | ({ id: number; kind: "alert"; resolve: (value: DialogValue) => void } & AppAlertDialogOptions);

export interface AppDialogsApi {
  confirm: (options: AppConfirmDialogOptions) => Promise<boolean>;
  prompt: (options: AppPromptDialogOptions) => Promise<string | null>;
  alert: (options: AppAlertDialogOptions) => Promise<void>;
}

let nextDialogId = 1;
let appDialogHost: ((request: PendingAppDialog) => void) | null = null;
const queuedBeforeHost: PendingAppDialog[] = [];

function enqueueDialog<T extends DialogValue>(
  request: Omit<PendingAppDialog, "id" | "resolve">,
): Promise<T> {
  return new Promise<T>((resolve) => {
    const pending = {
      ...request,
      id: nextDialogId++,
      resolve: resolve as (value: DialogValue) => void,
    } as PendingAppDialog;
    if (appDialogHost) {
      appDialogHost(pending);
    } else {
      queuedBeforeHost.push(pending);
    }
  });
}

export function confirmAppDialog(options: AppConfirmDialogOptions): Promise<boolean> {
  return enqueueDialog<boolean>({ kind: "confirm", ...options });
}

export function promptAppDialog(options: AppPromptDialogOptions): Promise<string | null> {
  return enqueueDialog<string | null>({ kind: "prompt", ...options });
}

export async function alertAppDialog(options: AppAlertDialogOptions): Promise<void> {
  await enqueueDialog<undefined>({ kind: "alert", ...options });
}

const AppDialogsContext = createContext<AppDialogsApi>({
  confirm: confirmAppDialog,
  prompt: promptAppDialog,
  alert: alertAppDialog,
});

export function useAppDialogs(): AppDialogsApi {
  return useContext(AppDialogsContext);
}

export function AppDialogProvider({ children }: { children: ReactNode }) {
  const [queue, setQueue] = useState<PendingAppDialog[]>([]);

  const enqueue = useCallback((request: PendingAppDialog) => {
    setQueue((current) => current.concat(request));
  }, []);

  useEffect(() => {
    appDialogHost = enqueue;
    if (queuedBeforeHost.length > 0) {
      const queued = queuedBeforeHost.splice(0);
      setQueue((current) => current.concat(queued));
    }
    return () => {
      if (appDialogHost === enqueue) {
        appDialogHost = null;
      }
    };
  }, [enqueue]);

  const resolveDialog = useCallback((dialog: PendingAppDialog, value: DialogValue) => {
    dialog.resolve(value);
    setQueue((current) => current.filter((entry) => entry.id !== dialog.id));
  }, []);

  const api = useMemo<AppDialogsApi>(
    () => ({
      confirm: confirmAppDialog,
      prompt: promptAppDialog,
      alert: alertAppDialog,
    }),
    [],
  );

  const active = queue[0] ?? null;

  return (
    <AppDialogsContext.Provider value={api}>
      {children}
      {active?.kind === "confirm" && (
        <ConfirmDialog
          title={active.title}
          message={active.message}
          confirmLabel={active.confirmLabel}
          cancelLabel={active.cancelLabel}
          danger={active.danger}
          onCancel={() => resolveDialog(active, false)}
          onConfirm={() => resolveDialog(active, true)}
        />
      )}
      {active?.kind === "prompt" && (
        <TextInputDialog
          title={active.title}
          label={active.label}
          initialValue={active.initialValue}
          placeholder={active.placeholder}
          allowEmpty={active.allowEmpty}
          confirmLabel={active.confirmLabel}
          cancelLabel={active.cancelLabel}
          onCancel={() => resolveDialog(active, null)}
          onConfirm={(value) => resolveDialog(active, value)}
        />
      )}
      {active?.kind === "alert" && (
        <AlertDialog
          title={active.title}
          message={active.message}
          okLabel={active.okLabel}
          onClose={() => resolveDialog(active, undefined)}
        />
      )}
    </AppDialogsContext.Provider>
  );
}
