import { Activity, type ReactNode } from "react";

/** Keep local drafts while suspending hidden controls and global UI effects. */
export function RetainedPrimaryView({ active, children }: { active: boolean; children: ReactNode }) {
  return <div className="absolute inset-0" style={{ display: active ? "block" : "none" }} inert={!active} aria-hidden={!active}>
    <Activity mode={active ? "visible" : "hidden"}>{children}</Activity>
  </div>;
}
