import { cleanup, render } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";
import { SessionProtocolIcon } from "./SessionProtocolIcon";
import { TabIcon } from "../tabbar/tabs/TabItem";
import type { Tab } from "../../types";

afterEach(cleanup);

it.each([
  ["LocalShell", { type: "terminal" }],
  ["WSL", { type: "terminal", localShell: { id: "C:/Windows/System32/WSL.EXE" } }],
  ["Serial", { type: "terminal", commandTerminal: { kind: "Serial" } }],
  ["Mosh", { type: "terminal", commandTerminal: { kind: "Mosh" } }],
  ["Mail", { type: "mail" }],
  ["SSH", { type: "terminal", ssh: {} }],
  ["MySQL", { type: "database", db: { engine: "MySQL" } }],
  ["Redis", { type: "redis" }],
  ["HBaseShell", { type: "hbase-shell" }],
  ["VNC", { type: "vnc" }],
  ["RDP", { type: "rdp" }],
] as const)("uses the same %s glyph and theme color in the session tree and tab", (protocol, tab) => {
  const { container } = render(<>
    <SessionProtocolIcon protocol={protocol} className="size-3.5" />
    <TabIcon tab={{ id: "session-test", title: protocol, ...tab } as Tab} />
  </>);
  const [row, header] = container.querySelectorAll("svg");
  expect(row).toHaveAttribute("data-session-protocol", protocol);
  expect(header).toHaveAttribute("data-session-protocol", protocol);
  expect(header.innerHTML).toEqual(row.innerHTML);
  expect(header.style.color).toEqual(row.style.color);
  expect(header.style.color).toMatch(/^var\(--taomni-/);
});
