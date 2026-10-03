import { describe, expect, it } from "vitest";
import { isEditableTarget, mailShortcutAction, type MailShortcutKey } from "./mailShortcuts";

function key(value: string, mods: Partial<MailShortcutKey> = {}): MailShortcutKey {
  return { key: value, ctrlKey: false, metaKey: false, shiftKey: false, altKey: false, ...mods };
}

describe("mailShortcutAction", () => {
  it("maps Thunderbird plain keys", () => {
    expect(mailShortcutAction(key("f"))).toBe("next");
    expect(mailShortcutAction(key("b"))).toBe("prev");
    expect(mailShortcutAction(key("n"))).toBe("nextUnread");
    expect(mailShortcutAction(key("m"))).toBe("toggleRead");
    expect(mailShortcutAction(key("S"))).toBe("star");
    expect(mailShortcutAction(key("a"))).toBe("archive");
    expect(mailShortcutAction(key("j"))).toBe("junk");
    expect(mailShortcutAction(key("J", { shiftKey: true }))).toBe("notJunk");
    expect(mailShortcutAction(key("Delete"))).toBe("delete");
  });

  it("maps reply/forward/search chords", () => {
    expect(mailShortcutAction(key("r"))).toBe("reply");
    expect(mailShortcutAction(key("R", { shiftKey: true }))).toBe("replyAll");
    expect(mailShortcutAction(key("r", { ctrlKey: true }))).toBe("reply");
    expect(mailShortcutAction(key("R", { metaKey: true, shiftKey: true }))).toBe("replyAll");
    expect(mailShortcutAction(key("l", { ctrlKey: true }))).toBe("forward");
    expect(mailShortcutAction(key("K", { ctrlKey: true, shiftKey: true }))).toBe("focusSearch");
  });

  it("leaves global and unrelated chords alone", () => {
    expect(mailShortcutAction(key("L", { ctrlKey: true, shiftKey: true }))).toBeNull();
    expect(mailShortcutAction(key("S", { ctrlKey: true, shiftKey: true }))).toBeNull();
    expect(mailShortcutAction(key("s", { ctrlKey: true }))).toBeNull();
    expect(mailShortcutAction(key("f", { altKey: true }))).toBeNull();
    expect(mailShortcutAction(key("x"))).toBeNull();
  });
});

describe("isEditableTarget", () => {
  it("detects inputs, editors and content-editable surfaces", () => {
    const input = document.createElement("input");
    const editor = document.createElement("div");
    editor.className = "cm-editor";
    const inner = document.createElement("span");
    editor.appendChild(inner);
    const rich = document.createElement("div");
    rich.setAttribute("contenteditable", "true");
    const plain = document.createElement("div");
    expect(isEditableTarget(input)).toBe(true);
    expect(isEditableTarget(inner)).toBe(true);
    expect(isEditableTarget(rich)).toBe(true);
    expect(isEditableTarget(plain)).toBe(false);
    expect(isEditableTarget(null)).toBe(false);
  });
});
