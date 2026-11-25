// Runs inside the installed WebKitGTK renderer via its normal Tauri IPC bridge.
async function measureModularIo(input) {
  const { invoke, Channel } = window.__TAURI__.core;
  const id = crypto.randomUUID();
  let accumulated = "";
  let resolveOutput;
  let expected;
  const channel = new Channel((data) => {
    const bytes = new Uint8Array(data);
    accumulated += new TextDecoder().decode(bytes);
    if (resolveOutput && accumulated.includes(expected)) {
      const result = { text: accumulated, at: performance.now() };
      accumulated = "";
      const resolve = resolveOutput;
      resolveOutput = null;
      resolve(result);
    }
  });
  function until(marker) {
    expected = marker;
    return new Promise(resolve => { resolveOutput = resolve; });
  }
  const timings = { latencyMs: [], output: [], moduleInstallMs: [] };
  const ready = until("AC13-READY\n");
  try {
    await invoke("create_local_terminal", { sessionId: id, rows: 24, cols: 80,
      shell: "/bin/bash", shellArgs: ["--noprofile", "--norc", "-c", 'exec /usr/bin/python3 -u "$1"', "probe", input.fixture],
      onOutput: channel });
    await ready;
    for (let i = 0; i < 35; ++i) {
      const marker = "ACK-" + i + "\n";
      const receipt = until(marker);
      const start = performance.now();
      await invoke("write_terminal", {sessionId: id, data: btoa("ping-" + i + "\n")});
      const reply = await receipt;
      if (reply.text !== marker) throw new Error("Wrong PTY echo: " + reply.text.slice(0, 120));
      if (i >= 5) timings.latencyMs.push(reply.at - start);
    }
    for (let i = 0; i < 6; ++i) {
      const receipt = until("AC13-END\n");
      const start = performance.now();
      await invoke("write_terminal", {sessionId: id, data: btoa("burst\n")});
      const reply = await receipt;
      const payload = reply.text.slice(0, -"AC13-END\n".length);
      if (payload.length !== 1048576 || /[^x]/.test(payload)) throw new Error("PTY payload corruption");
      if (i > 0) timings.output.push({bytes: payload.length, elapsedMs: reply.at - start});
    }
  } finally {
    await invoke("close_terminal", {sessionId: id});
  }
  try {
    for (let i = 0; i < 5; ++i) {
      const start = performance.now();
      const installed = await invoke("plugin_install_archive", {archivePath: input.archive, detachedSignature: input.signature});
      const elapsed = performance.now() - start;
      if (installed.manifest.id !== input.moduleId || installed.manifest.version !== input.version ||
          !["installed", "enabled"].includes(installed.state)) throw new Error("Unexpected module install result " + JSON.stringify(installed));
      timings.moduleInstallMs.push(elapsed);
      const removed = await invoke("plugin_uninstall", {slug: input.slug, deleteData: false});
      if (removed.state !== "uninstalled") throw new Error("Module was not uninstalled");
    }
  } catch (error) {
    timings.installError = String(error);
  }
  return timings;
}
