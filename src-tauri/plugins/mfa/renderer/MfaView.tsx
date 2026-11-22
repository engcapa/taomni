import { useLayoutEffect } from "react";
import type { MfaRendererInput } from "../../../../src/lib/mfa/rendererContract";
import { MfaFloatingWindow } from "./MfaFloatingWindow";
import { MfaTab } from "./MfaTab";
import mfaStyles from "./mfa.css?inline";

export default function MfaView(props: MfaRendererInput) {
  useLayoutEffect(() => {
    const styles = document.createElement("style");
    styles.textContent = mfaStyles;
    document.head.append(styles);
    return () => styles.remove();
  }, []);

  return props.view === "floating"
    ? <MfaFloatingWindow onExpand={props.onExpand} />
    : <MfaTab onStatusMessage={props.onStatusMessage} />;
}
