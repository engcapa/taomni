import { gitCheckoutBranch,gitCreateBranch,type GitBranch as GitBranchInfo } from "../../../lib/git";
import { confirmAppDialog,promptAppDialog } from "../../../lib/appDialogs";
import { rememberRecentBranch } from "../../../lib/gitRefList";


export async function confirmAndRun(title: string,message: string,danger: boolean,action: () => Promise<void>) {
  const ok=await confirmAppDialog({ title,message,danger,confirmLabel: title });
  if(ok) await action();
}


export async function checkoutBranch(
  repoRoot: string,
  branch: GitBranchInfo,
  runAction: (label: string,action: () => Promise<void>) => Promise<void>,
) {
  if(branch.remote) {
    const suggested=branch.name.split("/").slice(1).join("/")||branch.name;
    const localName=await promptAppDialog({
      title: "Checkout remote branch",
      label: "Local branch name",
      initialValue: suggested,
    });
    if(!localName) return;
    await runAction("Checkout remote branch",async () => {
      await gitCreateBranch(repoRoot,localName,branch.name,true);
      rememberRecentBranch(repoRoot,localName);
    });
    return;
  }
  await runAction("Checkout branch",async () => {
    await gitCheckoutBranch(repoRoot,branch.name);
    rememberRecentBranch(repoRoot,branch.name);
  });
}
