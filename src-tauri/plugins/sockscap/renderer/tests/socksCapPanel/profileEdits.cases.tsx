import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, it, vi } from "vitest";
import { sockscapSetConfig } from "../../../../../../src/lib/sockscap";
import { SocksCapPanel } from "../../SocksCapPanel";
import { fixtureState } from "./harness";

async function openUpstream() {
  const view = render(<SocksCapPanel />);
  const toggle = await screen.findByTestId("sockscap-section-upstream-toggle");
  if (toggle.getAttribute("aria-expanded") !== "true") fireEvent.click(toggle);
  return { port: screen.getByTestId<HTMLInputElement>("sockscap-upstream-port"), unmount: view.unmount };
}

export function registerProfileEditCases() {
  it("keeps typing responsive during a slow write and reopens the last complete endpoint", async () => {
    const user = userEvent.setup();
    const { port, unmount } = await openUpstream();
    let finishWrite!: () => void;
    const firstWrite = new Promise<void>(resolve => { finishWrite = resolve; });
    const writes = vi.mocked(sockscapSetConfig);
    writes.mockClear();
    writes.mockImplementationOnce(async config => {
      await firstWrite;
      fixtureState.currentCfg = config;
    });
    try {
      await user.clear(port);
      expect(port.value).toBe("");
      expect(writes).not.toHaveBeenCalled();
      await user.type(port, "19397");
      expect(port.value).toBe("19397");
      expect(writes).toHaveBeenCalledTimes(1);
      expect(screen.getByTestId("sockscap-panel").getAttribute("aria-busy")).toBe("true");
      fireEvent.change(screen.getByTestId("sockscap-upstream-host"), { target: { value: "localhost" } });
    } finally {
      await act(async () => finishWrite());
    }
    await waitFor(() => expect(screen.getByTestId("sockscap-panel").getAttribute("aria-busy")).toBe("false"));
    expect(fixtureState.currentCfg.profiles[0].upstream).toMatchObject({ port: 19397, host: "localhost" });
    expect(fixtureState.currentCfg.upstream).toEqual(fixtureState.currentCfg.profiles[0].upstream);
    unmount();
    expect((await openUpstream()).port.value).toBe("19397");
  });

  it("restores the last saved port after a rejected write and lets the user retry", async () => {
    const { port } = await openUpstream();
    vi.mocked(sockscapSetConfig).mockRejectedValueOnce(new Error("Profile write rejected"));
    fireEvent.change(port, { target: { value: "21000" } });
    expect(port.value).toBe("21000");
    await screen.findByText(/Profile write rejected/);
    expect(port.value).toBe("1080");
    fireEvent.change(port, { target: { value: "21002" } });
    await waitFor(() => expect(fixtureState.currentCfg.upstream.port).toBe(21002));
  });

  it("keeps an out-of-range draft off disk and applies the default only when a cleared port loses focus", async () => {
    fixtureState.currentCfg.upstream.port = 19391;
    fixtureState.currentCfg.profiles[0].upstream.port = 19391;
    const { port } = await openUpstream();
    const writes = vi.mocked(sockscapSetConfig);
    writes.mockClear();
    fireEvent.change(port, { target: { value: "65536" } });
    expect(port.value).toBe("65536");
    fireEvent.blur(port);
    expect(port.value).toBe("19391");
    expect(writes).not.toHaveBeenCalled();
    fireEvent.change(port, { target: { value: "" } });
    expect(writes).not.toHaveBeenCalled();
    fireEvent.blur(port);
    await waitFor(() => expect(fixtureState.currentCfg.upstream.port).toBe(1080));
  });

  it("keeps incomplete unconfigured upstream edits as a local draft until host and port are valid", async () => {
    fixtureState.currentCfg.upstream = { kind: "http", sessionId: "", host: "", port: 0 };
    fixtureState.currentCfg.profiles[0].upstream = { kind: "http", sessionId: "", host: "", port: 0 };
    const writes = vi.mocked(sockscapSetConfig);
    writes.mockClear();
    writes.mockImplementation(async (config) => {
      for (const p of config.profiles.filter((item) => item.enabled && config.activeProfileIds.includes(item.id))) {
        if (!(p.upstream.sessionId ?? "").trim()) {
          if (!(p.upstream.host ?? "").trim()) throw new Error("upstream host is empty");
          if (!p.upstream.port) throw new Error("upstream port must be > 0");
        }
      }
      fixtureState.currentCfg = JSON.parse(JSON.stringify(config));
    });
    try {
      const { port } = await openUpstream();
      const kindSelect = screen.getByTestId<HTMLSelectElement>("sockscap-upstream-kind");
      fireEvent.change(kindSelect, { target: { value: "trojan" } });
      expect(kindSelect.value).toBe("trojan");
      expect(screen.getByTestId("sockscap-sharelink-input")).toBeInTheDocument();
      expect(writes).not.toHaveBeenCalled();

      const hostInput = screen.getByTestId<HTMLInputElement>("sockscap-upstream-host");
      fireEvent.change(hostInput, { target: { value: "127.0.0.2" } });
      expect(hostInput.value).toBe("127.0.0.2");
      expect(writes).not.toHaveBeenCalled();

      fireEvent.change(port, { target: { value: "19392" } });
      await waitFor(() => expect(writes).toHaveBeenCalledTimes(1));
      await waitFor(() =>
        expect(fixtureState.currentCfg.upstream).toMatchObject({
          kind: "trojan",
          host: "127.0.0.2",
          port: 19392,
        }),
      );
    } finally {
      writes.mockImplementation(async (cfg) => {
        fixtureState.currentCfg = JSON.parse(JSON.stringify(cfg));
      });
    }
  });
}
