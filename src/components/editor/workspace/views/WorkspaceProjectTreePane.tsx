import type { ComponentProps } from "react";
import { selectCodeWorkspaceUi, useCodeWorkspaceStore } from "../../../../stores/codeWorkspaceStore";
import { FileTreePane } from "../FileTreePane";
import { ProjectTree } from "../ProjectTree";

interface Props {
  workspaceInstanceId: string;
  paneProps: Omit<ComponentProps<typeof FileTreePane>, "children" | "canMutateSelection">;
  treeProps: Omit<ComponentProps<typeof ProjectTree>, "selected">;
}

/** Selection paints the tree without reconstructing editor and tool chrome. */
export function WorkspaceProjectTreePane({ workspaceInstanceId, paneProps, treeProps }: Props) {
  const selected = useCodeWorkspaceStore((state) => selectCodeWorkspaceUi(state, workspaceInstanceId).treeSelection);
  return <FileTreePane {...paneProps} canMutateSelection={!!selected}>
    <ProjectTree {...treeProps} selected={selected} />
  </FileTreePane>;
}
