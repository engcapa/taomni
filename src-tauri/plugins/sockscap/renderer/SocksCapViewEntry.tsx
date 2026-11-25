import { useLayoutEffect } from "react";
import { SocksCapPanel } from "./SocksCapPanel";
import type { Props } from "./panel/configuration";
import styles from "./sockscap.css?inline";

export default function SocksCapViewEntry(props: Props) {
  useLayoutEffect(() => {
    const stylesheet = document.createElement("style");
    stylesheet.textContent = styles;
    document.head.append(stylesheet);
    return () => stylesheet.remove();
  }, []);
  return <SocksCapPanel {...props} />;
}
