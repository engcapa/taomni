/** Tao Home state is instance scoped. The controller is exported from the
 * component package so another host can create its own independent session. */
export { createChatController } from "../../components/tao/ai-chat";
export type { TaoChatController, TaoChatState } from "../../components/tao/ai-chat";
