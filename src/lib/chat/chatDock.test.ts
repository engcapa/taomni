import { describe, expect, it } from "vitest";
import {
  CHAT_DOCK_MIN_STACK_HEIGHT,
  CHAT_DOCK_NARROW_WIDTH,
  resolveChatDock,
} from "./chatDock";

describe("resolveChatDock", () => {
  const wide = 1200;
  const tall = 900;

  it("docks left/right pinned as a side column regardless of size", () => {
    expect(resolveChatDock("left", true, wide, tall)).toBe("side-inline");
    expect(resolveChatDock("right", true, wide, tall)).toBe("side-inline");
    // Left/right pinning must NOT regress on a narrow window.
    expect(resolveChatDock("left", true, 320, 300)).toBe("side-inline");
  });

  it("docks top/bottom pinned as a stacked band on a roomy window", () => {
    expect(resolveChatDock("top", true, wide, tall)).toBe("stacked-inline");
    expect(resolveChatDock("bottom", true, wide, tall)).toBe("stacked-inline");
  });

  it("falls back to floating for top/bottom on a narrow or short window", () => {
    expect(resolveChatDock("top", true, CHAT_DOCK_NARROW_WIDTH - 1, tall)).toBe("floating");
    expect(resolveChatDock("bottom", true, wide, CHAT_DOCK_MIN_STACK_HEIGHT - 1)).toBe("floating");
  });

  it("is floating whenever the drawer is unpinned", () => {
    expect(resolveChatDock("left", false, wide, tall)).toBe("floating");
    expect(resolveChatDock("top", false, wide, tall)).toBe("floating");
    expect(resolveChatDock("bottom", false, wide, tall)).toBe("floating");
  });
});
