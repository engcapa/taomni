import type { TaoThread } from "../../components/tao/ai-chat";

export function sortTaoThreads(threads: TaoThread[]): TaoThread[] {
  return [...threads].sort((left, right) => right.updatedAt - left.updatedAt);
}
