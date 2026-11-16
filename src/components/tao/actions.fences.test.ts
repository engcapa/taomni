import { describe, expect, it } from "vitest";
import { parseActionProposals } from "./actions";
import { completeReply } from "./ai-chat/replyCompletion";
import type { TaoMessage } from "./ai-chat/ports";

const content = '# Project\n\n```sh\npython -m unittest\n```\n\nQuoted "value" and C:\\work\\tasks.\n\n```tao-action\n{"id":"example-only"}\n```\n';
const proposal = { id: "readme", kind: "write_file", title: "Write README", payload: { path: "README.md", content } };
const fenced = (value: object, marker = "```") => `${marker}tao-action\n${JSON.stringify(value)}\n${marker}`;
const reply = (text: string): TaoMessage => ({ id: "reply", role: "assistant", text, createdAt: 1, blocks: [{ id: "body", type: "text", text }] });

describe("file actions containing Markdown fences", () => {
  it("retains complete README bytes and the following proposal", () => {
    const actions = parseActionProposals(`${fenced(proposal)}\n${fenced({ ...proposal, id: "status", payload: { path: "status.txt", content: "Ready" } })}`);
    expect(actions).toHaveLength(2);
    expect(actions[0].payload.content).toBe(content);
    expect(actions[1].payload.path).toBe("status.txt");
  });

  it("supports longer fences and escaped quotes/backslashes without inventing nested actions", () => {
    const actions = parseActionProposals(fenced(proposal, "````"));
    expect(actions).toHaveLength(1);
    expect(actions[0].payload.content).toBe(content);
  });

  it("removes the complete valid action from visible text while retaining malformed proposals", () => {
    const invalid = '```tao-action\n{"id":"broken"}\n```';
    const completed = completeReply(reply(`Plan\n${fenced(proposal)}\n${invalid}\nAwait approval`), true, () => "id");
    expect(completed.text).toBe(`Plan\n\n${invalid}\nAwait approval`);
    expect(completed.blocks.find((block) => block.type === "text")?.text).toBe(completed.text);
    expect(completed.blocks.filter((block) => block.type === "action")).toHaveLength(1);
    expect(completed.blocks.find((block) => block.type === "action")?.action?.payload.content).toBe(content);
  });

  it("keeps truncated and read-only proposals visible without publishing actions", () => {
    const text = fenced(proposal);
    const truncated = { ...reply(text), stopReason: "max_tokens" as const };
    expect(completeReply(truncated, true, () => "id")).toBe(truncated);
    const readonly = completeReply(reply(text), false, () => "id");
    expect(readonly.text).toBe(text);
    expect(readonly.blocks.some((block) => block.type === "action")).toBe(false);
  });
});
