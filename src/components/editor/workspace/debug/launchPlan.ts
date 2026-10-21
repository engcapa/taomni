import { type DebugLaunchNode,type DebugLaunchGroup } from "./types";

export function isDebugLaunchGroup(node: DebugLaunchNode): node is DebugLaunchGroup {
  return "children" in node;
}

export function validateDebugLaunchGroup(plan: DebugLaunchGroup): void {
  const visiting=new Set<DebugLaunchNode>();
  const visit=(node: DebugLaunchNode) => {
    if(visiting.has(node)) throw new Error(`Compound Debug cycle at ${node.label}`);
    if(!node.id.trim()) throw new Error("Compound Debug contains an empty configuration id");
    if(!isDebugLaunchGroup(node)) {
      if(!node.adapterId.trim()) throw new Error(`Debug adapter is missing for ${node.label}`);
      return;
    }
    if(node.children.length===0) throw new Error(`Compound Debug has no children: ${node.label}`);
    visiting.add(node);
    for(const child of node.children) visit(child);
    visiting.delete(node);
  };
  visit(plan);
}
