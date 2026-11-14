import type { TaoChatController } from "../../components/tao/ai-chat";

export async function sendTaoMessage(controller: TaoChatController, content: string): Promise<boolean> {
  return controller.send(content);
}
