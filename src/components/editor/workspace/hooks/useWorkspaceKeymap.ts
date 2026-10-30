import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { registerShellKeyClaim } from "../../../../lib/shellKeyClaims";
import {
  BUILTIN_KEYMAP_PRESETS,
  consumeKeymapDefaultsMigrationNotice,
  isBuiltinKeymapScheme,
  readKeymapSchemes,
  writeKeymapSchemes,
  type KeymapSchemeV3,
} from "../workspaceKeymapScheme";
import { attachWorkspaceMouseDispatcher } from "../workspaceMouseDispatcher";


export interface UseWorkspaceKeymapContext {
  actionsController: import("../useWorkspaceActionsController").WorkspaceActionsController;
  rootRef: import("react").RefObject<HTMLDivElement | null>;
  visible: boolean;
}

export function useWorkspaceKeymap(context: UseWorkspaceKeymapContext) {
  const { actionsController, rootRef, visible } = context;

  // §8.18.2 editable Keymap: per-app-profile scheme store; the active scheme
  // is applied to the live action host so every dispatcher/surface shares it.
  const keymapStore = useMemo(() => readKeymapSchemes(), []);
  const [keymapSchemes, setKeymapSchemes] = useState<KeymapSchemeV3[]>(keymapStore.schemes);
  const [activeKeymapSchemeId, setActiveKeymapSchemeId] = useState<string | null>(keymapStore.activeId);
  const [keymapSettingsOpen, setKeymapSettingsOpen] = useState(false);
  /** Action to record a shortcut for when the dialog opens (Assign Shortcut). */
  const [keymapAssignActionId, setKeymapAssignActionId] = useState<string | null>(null);
  const keymapCorruptDiagnostic = keymapStore.recoveredFromCorrupt
    ? "Stored keymap was corrupted; a backup was kept and defaults are active."
    : null;
  const activeKeymapScheme = useMemo(
    () => [...keymapSchemes, ...BUILTIN_KEYMAP_PRESETS].find((scheme) => scheme.id === activeKeymapSchemeId) ?? null,
    [keymapSchemes, activeKeymapSchemeId],
  );
  // ED-PARITY-013 DEC-013-06: one-time notice for profiles that used the
  // pre-IDEA defaults (F12 / Ctrl+Alt+S). Decided once at mount.
  const [keymapMigrationNoticeOpen, setKeymapMigrationNoticeOpen] = useState(
    () => consumeKeymapDefaultsMigrationNotice(),
  );

  useEffect(() => {
    writeKeymapSchemes(keymapSchemes, activeKeymapSchemeId);
  }, [keymapSchemes, activeKeymapSchemeId]);

  useEffect(() => {
    actionsController.host.setKeymapScheme(activeKeymapScheme);
    actionsController.projection.publish();
  }, [actionsController.host, actionsController.projection, activeKeymapScheme]);

  // IDEA's macOS keymap binds Cmd+1..0 to tool windows; the app shell's Cmd+N
  // tab switch yields those strokes while focus is inside this workspace.
  useEffect(() => {
    const root = rootRef.current;
    if (!root) return undefined;
    const host = actionsController.host;
    return registerShellKeyClaim(root, (event) => host.claimsSingleStroke(event));
  }, [actionsController.host, visible]);

  // §8.19.2: one workspace-root mouse dispatcher; unbound gestures (text
  // selection, editing) pass through untouched. Re-attach only when the
  // element or host instance changes.
  const mouseHostRef = useRef(actionsController.host);
  mouseHostRef.current = actionsController.host;
  useEffect(() => {
    const root = rootRef.current;
    if (!root) return undefined;
    const attached = attachWorkspaceMouseDispatcher(mouseHostRef.current, root);
    return () => attached.dispose();
  }, [visible]);

  // ED-PARITY-004 DEC-03: the Keymap dialog's Apply is the only edge that
  // reaches this. `null` means the user deleted the active scheme and the app
  // is back on the built-in defaults.
  const applyKeymapScheme = useCallback((scheme: KeymapSchemeV3 | null) => {
    // Built-in presets ship with the app: only their id becomes active.
    if (scheme && !isBuiltinKeymapScheme(scheme.id)) {
      setKeymapSchemes((schemes) => {
        const exists = schemes.some((entry) => entry.id === scheme.id);
        return exists
          ? schemes.map((entry) => (entry.id === scheme.id ? scheme : entry))
          : [...schemes, scheme];
      });
    }
    setActiveKeymapSchemeId(scheme?.id ?? null);
  }, []);
  return { setKeymapSettingsOpen, setKeymapAssignActionId, keymapMigrationNoticeOpen, keymapSettingsOpen, setKeymapMigrationNoticeOpen, keymapSchemes, activeKeymapSchemeId, keymapCorruptDiagnostic, setActiveKeymapSchemeId, setKeymapSchemes, applyKeymapScheme, keymapAssignActionId };
}
