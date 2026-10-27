import type { MailFolder } from "../../../lib/mail";

const subscribedFlag = "\\Subscribed";
const subscribed = (folder: MailFolder) => folder.flags.some((flag) => flag.toLowerCase() === subscribedFlag.toLowerCase());

/** Per-account ordering for the subscription bit, independent of message counts.
 * A read started before a successful mutation may still update counts and other
 * attributes, but cannot undo the server-confirmed subscription. Later reads
 * remain authoritative, including changes made by another mail client.
 */
export class MailSubscriptionSnapshots {
  private revision = 0;
  private changes = new Map<string, { revision: number; subscribed: boolean; }>();

  capture() {
    return this.revision;
  }

  confirm(folder: MailFolder) {
    this.changes.set(folder.name, { revision: ++this.revision, subscribed: subscribed(folder) });
  }

  merge(folders: MailFolder[], readRevision: number): MailFolder[] {
    return folders.map((folder) => {
      const change = this.changes.get(folder.name);
      if (!change || change.revision <= readRevision || change.subscribed === subscribed(folder)) return folder;
      const flags = folder.flags.filter((flag) => flag.toLowerCase() !== subscribedFlag.toLowerCase());
      if (change.subscribed) flags.push(subscribedFlag);
      return { ...folder, flags };
    });
  }
}
