import { useState } from "react";
import { useChatStore } from "../../stores/chatStore";
import { useNotesStore } from "../../stores/notesStore";
import { useTaoHubStore } from "../../stores/taoHubStore";
import { isTauriRuntime } from "../../lib/runtime";
import { NotesPanel } from "../notes/NotesPanel";
import { StableSurface } from "./SurfaceSlot";

/** One notes controller survives Hub tabs, hiding, and browser float/dock moves. */
export function ShellNotesSurface() {
  const hubTab = useTaoHubStore((s) => s.hubTab);
  const drawerOpen = useChatStore((s) => s.drawerOpen);
  const mode = useNotesStore((s) => s.panelMode);
  const [used, setUsed] = useState(false);
  const requested = hubTab === "notes" || mode === "floating";
  if (requested && !used) setUsed(true);
  if (!used && !requested) return null;
  const floating = mode === "floating";
  return <StableSurface id="notes" slot={floating && !isTauriRuntime() ? "notes:floating" : "notes:hub"}
    visible={floating ? !isTauriRuntime() : drawerOpen && hubTab === "notes"}>
    <div className="h-full min-h-0 flex flex-col"><NotesPanel showPanelModeToggle={!floating} /></div>
  </StableSurface>;
}
