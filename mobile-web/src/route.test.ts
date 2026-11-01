import { expect, it } from "vitest";
import { parseRoute, routeHash, type Route } from "./route";

it("round-trips every view through the hash", () => {
  const routes: Route[] = [
    { view: "instances" },
    { view: "pair" },
    { view: "pair", sessionId: "thread:abc123" },
    { view: "instance", instanceId: "http://192.168.1.5:8787:device-1" },
    { view: "instance", instanceId: "https://pc.example:device", sessionId: "term:ws:abc:local:x9" },
    { view: "link", sessionId: "thread:4f2a" },
  ];
  for (const route of routes) expect(parseRoute(routeHash(route))).toEqual(route);
});

it("accepts the deep link format the instance sends to Feishu", () => {
  expect(parseRoute("#/session/thread%3Aabc123")).toEqual({ view: "link", sessionId: "thread:abc123" });
  expect(parseRoute("#/session/term%3Alocal-1")).toEqual({ view: "link", sessionId: "term:local-1" });
});

it("falls back to the instance list for empty or malformed hashes", () => {
  expect(parseRoute("")).toEqual({ view: "instances" });
  expect(parseRoute("#/")).toEqual({ view: "instances" });
  expect(parseRoute("#/session/%E0%A4%A")).toEqual({ view: "instances" });
  expect(parseRoute("#/i/x/s/%E0%A4%A")).toEqual({ view: "instances" });
  expect(parseRoute("#/unknown/path")).toEqual({ view: "instances" });
});
