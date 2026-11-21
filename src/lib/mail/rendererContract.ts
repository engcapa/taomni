import type { MailTabInfo } from "../../types";
import type { PluginFrontendProps } from "../pluginFrontendHost";

export type MailRendererInput =
  | { view: "account"; info: MailTabInfo; onEditSession?: (sessionId: string) => void }
  | { view: "unified"; accounts: MailTabInfo[]; onOpenAccount?: (sessionId: string) => void };

export type MailRendererProps = MailRendererInput & Pick<PluginFrontendProps, "active" | "tabId">;
