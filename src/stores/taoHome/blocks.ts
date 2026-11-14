import type { TaoBlock, TaoMessage } from "../../components/tao/ai-chat";

export function visibleBlocks(message: TaoMessage): TaoBlock[] {
  return message.blocks.filter((block) => block.type !== "error" || Boolean(block.error));
}

export function textFromBlocks(blocks: TaoBlock[]): string {
  return blocks.filter((block) => block.type === "text").map((block) => block.text ?? "").join("");
}
