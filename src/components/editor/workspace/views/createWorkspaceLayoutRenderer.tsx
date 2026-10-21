import { Fragment, type ReactNode } from "react";
import { Panel, Group as PanelGroup, Separator as PanelResizeHandle } from "react-resizable-panels";
import { useCodeWorkspaceStore, type EditorGroupId } from "../../../../stores/codeWorkspaceStore";
import { panelLayoutToRatios, type LayoutNode } from "../recursiveLayoutTree";


export interface CreateWorkspaceLayoutRendererContext {
  setLayoutNodeRatios: ReturnType<typeof useCodeWorkspaceStore.getState>["setLayoutNodeRatios"];
  workspaceInstanceId: string;
}

export function createWorkspaceLayoutRenderer(context: CreateWorkspaceLayoutRendererContext) {
  const { setLayoutNodeRatios, workspaceInstanceId } = context;

  const renderRecursiveLayoutNode = (
    node: LayoutNode,
    renderGroup: (groupId: EditorGroupId) => ReactNode,
  ): ReactNode => {
    if (node.type === "leaf") {
      return renderGroup(node.id);
    }
    return (
      <PanelGroup
        key={node.id}
        orientation={node.orientation === "vertical" ? "horizontal" : "vertical"}
        id={`recursive-split-${node.id}`}
        className="h-full min-h-0"
        onLayoutChanged={(layout) => {
          const ratios = panelLayoutToRatios(layout, node.children.map((child) => child.id));
          if (ratios) setLayoutNodeRatios(workspaceInstanceId, node.id, ratios);
        }}
      >
        {node.children.map((child, index) => {
          const pct = node.ratios[index] ? `${Math.round(node.ratios[index] * 100)}%` : `${Math.round(100 / node.children.length)}%`;
          return (
            <Fragment key={child.id}>
              {index > 0 && (
                <PanelResizeHandle
                  className={node.orientation === "vertical"
                    ? "w-[3px] bg-[var(--taomni-code-border)] hover:bg-[var(--taomni-accent)]"
                    : "h-[3px] bg-[var(--taomni-code-border)] hover:bg-[var(--taomni-accent)]"}
                />
              )}
              <Panel id={`panel-${child.id}`} defaultSize={pct} minSize="10%" className="min-h-0 min-w-0">
                {renderRecursiveLayoutNode(child, renderGroup)}
              </Panel>
            </Fragment>
          );
        })}
      </PanelGroup>
    );
  };
  return { renderRecursiveLayoutNode };
}
