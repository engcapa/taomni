import { describe, expect, it } from "vitest";
import { isSockscapWindowUrl, sockscapBrowserWindowUrl } from "./sockscapWindowing";

describe("Sockscap window routing", () => {
  it("recognizes the native hash route and browser query route", () => {
    expect(isSockscapWindowUrl("tauri://localhost/index.html#sockscap")).toBe(true);
    expect(isSockscapWindowUrl("http://localhost:5000/?sockscap=1")).toBe(true);
    expect(isSockscapWindowUrl("http://localhost:5000/#sftp=session-1")).toBe(false);
  });

  it("builds a browser popup URL without retaining a detached-session hash", () => {
    expect(sockscapBrowserWindowUrl("http://localhost:5000/#notes=notes")).toBe(
      "http://localhost:5000/?sockscap=1",
    );
  });
});
