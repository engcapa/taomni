import { beforeEach, expect, it } from "vitest";
import { mobileStub } from "./mobileStub";

beforeEach(() => localStorage.clear());

it("previews a restricted policy by default and persists normalized settings across service toggles", async () => {
  expect(await mobileStub("mobile_listener_get")).toEqual({ allowed_hosts: [], allow_all_hosts: false });
  const config = { allowed_hosts: [" Proxy.Example ", "proxy.example", "pc.example:8443"], allow_all_hosts: true };
  expect(await mobileStub("mobile_listener_save", { config })).toEqual({ allowed_hosts: ["proxy.example", "pc.example:8443"], allow_all_hosts: true });
  await mobileStub("mobile_start", { port: 8787 });
  await mobileStub("mobile_stop");
  expect(await mobileStub("mobile_listener_get")).toEqual({ allowed_hosts: ["proxy.example", "pc.example:8443"], allow_all_hosts: true });
});

it("does not replace the saved preview policy on invalid hosts or excess entries", async () => {
  const config = { allowed_hosts: ["proxy.example"], allow_all_hosts: false };
  await mobileStub("mobile_listener_save", { config });
  for (const host of ["https://bad.example/", "*.example.com", "a.example/path", "user@pc.example", "pc.example:65536"]) {
    await expect(mobileStub("mobile_listener_save", { config: { allowed_hosts: [host], allow_all_hosts: true } })).rejects.toThrow("invalid_mobile_host");
  }
  await expect(mobileStub("mobile_listener_save", { config: { allowed_hosts: Array(33).fill("pc.example"), allow_all_hosts: false } })).rejects.toThrow("too_many_mobile_hosts");
  expect(await mobileStub("mobile_listener_get")).toEqual(config);
});

it("defaults screen capture opt-in to false and persists changes across mobile_status calls", async () => {
  expect((await mobileStub("mobile_status") as { allow_screen_capture: boolean }).allow_screen_capture).toBe(false);
  expect(await mobileStub("mobile_set_screen_capture", { enabled: true })).toBe(true);
  expect((await mobileStub("mobile_status") as { allow_screen_capture: boolean }).allow_screen_capture).toBe(true);
});
