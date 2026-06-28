import { describe, expect, it } from "vitest";
import { parseQuickConnectInput } from "./quickConnect";

describe("parseQuickConnectInput", () => {
  it("parses RDP URLs as password-auth sessions", () => {
    const parsed = parseQuickConnectInput("rdp://alice@win.example.test:3390");

    expect(parsed.config).toMatchObject({
      session_type: "RDP",
      host: "win.example.test",
      port: 3390,
      username: "alice",
      auth_method: "Password",
    });
  });

  it("uses the default RDP port when the URL omits one", () => {
    const parsed = parseQuickConnectInput("rdp://win.example.test");

    expect(parsed.config).toMatchObject({
      session_type: "RDP",
      host: "win.example.test",
      port: 3389,
      auth_method: "Password",
    });
  });

  it.each([
    ["rlogin://bob@legacy.example.test", "Rlogin", "legacy.example.test", 513, "bob"],
    ["mosh alice@edge.example.test", "Mosh", "edge.example.test", 60001, "alice"],
  ])("preserves planned client protocol %s", (input, sessionType, host, port, username) => {
    const parsed = parseQuickConnectInput(input);

    expect(parsed.config).toMatchObject({
      session_type: sessionType,
      host,
      port,
      username,
      auth_method: "None",
    });
  });

  it.each([
    ["browser://docs.example.test", "https://docs.example.test"],
    ["browser https://docs.example.test/path?q=1", "https://docs.example.test/path?q=1"],
    ["https://docs.example.test/path?q=1", "https://docs.example.test/path?q=1"],
  ])("parses Browser targets as URL sessions", (input, url) => {
    const parsed = parseQuickConnectInput(input);

    expect(parsed.config).toMatchObject({
      name: url,
      session_type: "Browser",
      host: url,
      port: 0,
      username: null,
      auth_method: "None",
    });
  });
});
