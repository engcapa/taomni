import { useContextMenu } from "../../components/ContextMenu";
import { VaultGate } from "../../components/vault/VaultGate";
import { VaultSetupDialog } from "../../components/vault/VaultSetupDialog";
import { VaultUnlockDialog } from "../../components/vault/VaultUnlockDialog";
import { FLOATING_MFA_WIDTH } from "../../stores/app/layoutSlice";
import { useMfaStore } from "../../stores/mfaStore";
import { requireVaultUnlock, useVaultStore, vaultSessionIsCurrent } from "../../stores/vaultStore";
import { confirmAppDialog } from "../appDialogs";
import { readClipboardImageFiles, writeText } from "../clipboard";
import { startCustomDrag, useCustomDropTarget } from "../customDnD";
import { readFileBytes } from "../ipc";
import { NATIVE_FILE_DROP_EVENT } from "../osFileDrop";
import { isTauriRuntime } from "../runtime";
import { mfaCaptureScreens, mfaExportUri, mfaReadClipboardImage, mfaScanScreenTexts } from "./ipc";
import { isFloatingMfaOpen, useFloatingMfa } from "./rendererServices";

const host = {
  store: { useMfaStore },
  vault: { requireVaultUnlock, useVaultStore, vaultSessionIsCurrent, VaultGate, VaultSetupDialog, VaultUnlockDialog },
  floating: { FLOATING_MFA_WIDTH, isFloatingMfaOpen, useFloatingMfa },
  dialogs: { confirmAppDialog, useContextMenu },
  clipboard: { readClipboardImageFiles, writeText },
  drag: { startCustomDrag, useCustomDropTarget, NATIVE_FILE_DROP_EVENT },
  files: { readFileBytes },
  runtime: { isTauriRuntime },
  commands: { mfaCaptureScreens, mfaExportUri, mfaReadClipboardImage, mfaScanScreenTexts },
};

export type MfaRendererHost = typeof host;

export function installMfaRendererHost() {
  for (const service of Object.values(host)) Object.freeze(service);
  Object.defineProperty(globalThis, "__taomniMfaRendererHost", { value: Object.freeze(host) });
}
