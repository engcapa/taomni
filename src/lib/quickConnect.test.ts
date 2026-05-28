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
});
