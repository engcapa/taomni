import { describe, expect, it } from "vitest";
import { registerShellKeyClaim, shellKeyClaimed } from "./shellKeyClaims";

function keydown(target: Element, key: string): KeyboardEvent {
  const event = new KeyboardEvent("keydown", { key, metaKey: true, bubbles: true });
  Object.defineProperty(event, "target", { value: target });
  return event;
}

describe("shellKeyClaims", () => {
  it("yields a stroke only inside the registered surface that binds it", () => {
    const root = document.createElement("div");
    const inner = document.createElement("span");
    root.appendChild(inner);
    const outside = document.createElement("div");
    document.body.append(root, outside);
    const dispose = registerShellKeyClaim(root, (event) => event.key === "1");
    expect(shellKeyClaimed(keydown(inner, "1"))).toBe(true);
    expect(shellKeyClaimed(keydown(inner, "2"))).toBe(false);
    expect(shellKeyClaimed(keydown(outside, "1"))).toBe(false);
    dispose();
    expect(shellKeyClaimed(keydown(inner, "1"))).toBe(false);
    root.remove();
    outside.remove();
  });
});
