import { useLayoutEffect } from "react";
import { MailClientTab } from "./MailClientTab";
import { MailUnifiedTab } from "./MailUnifiedTab";
import type { MailRendererProps } from "../../../../src/lib/mail/rendererContract";
import mailStyles from "./mail.css?inline";

export default function MailView(props: MailRendererProps) {
  useLayoutEffect(() => {
    const styles = document.createElement("style");
    styles.textContent = mailStyles;
    document.head.append(styles);
    return () => styles.remove();
  }, []);
  if (props.view === "unified") {
    return <MailUnifiedTab accounts={props.accounts} visible={props.active} onOpenAccount={props.onOpenAccount} />;
  }
  return <MailClientTab tabId={props.tabId} info={props.info} visible={props.active} onEditSession={props.onEditSession} />;
}
