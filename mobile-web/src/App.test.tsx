import "@testing-library/jest-dom/vitest";
import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { App } from "./App";
import { saveInstances } from "./api";

vi.mock("./InstanceView", () => ({ InstanceView: () => null }));
afterEach(() => { cleanup(); localStorage.clear(); vi.restoreAllMocks(); });

it("keeps registrations visible offline and never mistakes browser connectivity for instance health", () => {
  saveInstances([{ id: "pc", deviceId: "phone", token: "secret", label: "Home PC", endpoint: "https://pc.example", lastOnline: 1700000000000 }]);
  const online = vi.spyOn(navigator, "onLine", "get").mockReturnValue(false);
  render(<App />);
  expect(screen.getByTestId("mobile-offline-note")).toHaveTextContent("实时状态可能已过期");
  expect(screen.getByTestId("mobile-instance-open")).toHaveTextContent("Home PC");
  expect(screen.getByTestId("mobile-instance-availability")).toHaveTextContent("本机离线");
  online.mockReturnValue(true);
  act(() => window.dispatchEvent(new Event("online")));
  expect(screen.queryByTestId("mobile-offline-note")).toBeNull();
  expect(screen.getByTestId("mobile-instance-availability")).toHaveTextContent("当前连通性未检查");
  online.mockReturnValue(false);
  act(() => window.dispatchEvent(new Event("offline")));
  expect(screen.getByTestId("mobile-offline-note")).toBeInTheDocument();
  expect(screen.getByTestId("mobile-instance-open")).toHaveTextContent("Home PC");
});
