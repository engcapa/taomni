import { expect, it } from "vitest";
import {
  breakpointModesFor,
  buildDataBreakpointInfoArgs,
  buildDisassembleArgs,
  buildReadMemoryArgs,
  buildSetBreakpointsArgs,
  buildSetDataBreakpointsArgs,
  buildSetExceptionBreakpointsArgs,
  buildSetFunctionBreakpointsArgs,
  buildSetInstructionBreakpointsArgs,
  buildWriteMemoryArgs,
  dataBreakpointKey,
  dataBreakpointVerificationMap,
  decodeMemoryData,
  defaultDataBreakpointAccessType,
  encodeMemoryData,
  functionBreakpointVerificationMap,
  instructionBreakpointKey,
  instructionBreakpointVerificationMap,
  parseBreakpointModes,
  parseDataBreakpointInfo,
  parseDisassembleResponse,
  parseExceptionBreakpointFilters,
  parseReadMemoryResponse,
  parseSetBreakpointsResponse,
  parseSetDataBreakpointsResponse,
  parseSetFunctionBreakpointsResponse,
  parseSetInstructionBreakpointsResponse,
  parseWriteMemoryResponse,
  planBreakpointSync,
  planDataBreakpointSync,
  planExceptionBreakpointSync,
  planFunctionBreakpointSync,
  planInstructionBreakpointSync,
  resolveBreakpointMode,
  stepCommandFor,
  toAdapterSourcePath,
} from "../../dapDebugModel";

export function registerdapDebugModelLayout1Cases() {
  it("converts Windows drive paths to lowercase drive + backslashes for the adapter", () => {
    // java-debug leaves breakpoints unverified unless the source path matches
    // JDT's native form (lowercase drive + backslashes).
    expect(toAdapterSourcePath("D:/code/ads/ique/src/App.java")).toBe("d:\\code\\ads\\ique\\src\\App.java");
    expect(toAdapterSourcePath("C:/Users/x/Main.java")).toBe("c:\\Users\\x\\Main.java");
  });

  it("leaves POSIX absolute paths unchanged", () => {
    expect(toAdapterSourcePath("/home/user/project/src/App.java")).toBe("/home/user/project/src/App.java");
  });

  it("maps step actions to DAP commands", () => {
    expect(stepCommandFor("continue")).toBe("continue");
    expect(stepCommandFor("stepOver")).toBe("next");
    expect(stepCommandFor("stepIn")).toBe("stepIn");
    expect(stepCommandFor("stepOut")).toBe("stepOut");
    expect(stepCommandFor("pause")).toBe("pause");
    expect(stepCommandFor("stepBack")).toBe("stepBack");
    expect(stepCommandFor("reverseContinue")).toBe("reverseContinue");
  });

  it("builds and parses bounded memory and disassembly requests", () => {
    expect(buildReadMemoryArgs({ memoryReference: " 0x1000 ", offset: -4, count: 16 })).toEqual({
      memoryReference: "0x1000",
      offset: -4,
      count: 16,
    });
    expect(parseReadMemoryResponse({
      address: "0x1000",
      unreadableBytes: 2,
      data: "AAE=",
    })).toEqual({ address: "0x1000", unreadableBytes: 2, data: "AAE=" });
    expect(buildWriteMemoryArgs({
      memoryReference: "0x1000",
      offset: 2,
      data: "AQI=",
      allowPartial: false,
    })).toEqual({ memoryReference: "0x1000", offset: 2, data: "AQI=", allowPartial: false });
    expect(parseWriteMemoryResponse({ bytesWritten: 2 })).toEqual({ bytesWritten: 2 });
    expect(buildDisassembleArgs({
      memoryReference: "entry",
      offset: 4,
      instructionOffset: -1,
      instructionCount: 2,
      resolveSymbols: true,
    })).toEqual({
      memoryReference: "entry",
      offset: 4,
      instructionOffset: -1,
      instructionCount: 2,
      resolveSymbols: true,
    });
    expect(parseDisassembleResponse({
      instructions: [{
        address: "0x1000",
        instructionBytes: "55",
        instruction: "push rbp",
        symbol: "main",
        location: { path: "/repo/App.java", name: "App.java", sourceReference: null },
        line: 9,
        column: 2,
      }, { address: "0x1001", instruction: "ret" }],
    })).toEqual([
      {
        address: "0x1000",
        instructionBytes: "55",
        instruction: "push rbp",
        symbol: "main",
        location: { path: "/repo/App.java", name: "App.java", sourceReference: null },
        line: 9,
        column: 2,
        endLine: null,
        endColumn: null,
      },
      {
        address: "0x1001",
        instructionBytes: null,
        instruction: "ret",
        symbol: null,
        location: null,
        line: null,
        column: null,
        endLine: null,
        endColumn: null,
      },
    ]);
  });

  it("converts memory bytes between hexadecimal and DAP base64", () => {
    const encoded = encodeMemoryData("0x01 02 ff");
    expect(encoded).toBe("AQL/");
    expect(decodeMemoryData(encoded ?? "")).toBe("01 02 ff");
    expect(encodeMemoryData("01 2")).toBeNull();
  });

  it("builds setBreakpoints args sorted, with condition + hitCondition + logMessage", () => {
    const args = buildSetBreakpointsArgs("/repo/src/App.java", planBreakpointSync([
      { line: 20 },
      { line: 5, condition: " x > 1 " },
      { line: 12, logMessage: "hit {x}" },
      { line: 8, hitCondition: " 5 " },
    ]));
    expect(args.source).toEqual({ path: "/repo/src/App.java", name: "App.java" });
    expect(args.breakpoints).toEqual([
      { line: 5, condition: "x > 1" },
      { line: 8, hitCondition: "5" },
      { line: 12, logMessage: "hit {x}" },
      { line: 20 },
    ]);
  });

  it("builds setBreakpoints args combining condition, hitCondition and logMessage on single breakpoint (D11.2)", () => {
    const args = buildSetBreakpointsArgs("/repo/src/App.java", planBreakpointSync([
      { line: 42, condition: "x > 10", hitCondition: "3", logMessage: "x is {x}" },
    ]));
    expect(args.breakpoints).toEqual([
      { line: 42, condition: "x > 10", hitCondition: "3", logMessage: "x is {x}" },
    ]);
  });

  it("parses breakpoint modes by applicability and uses the first applicable mode as default", () => {
    const modes = parseBreakpointModes({
      breakpointModes: [
        { mode: "software", label: "Software", appliesTo: ["source", "data"] },
        { mode: "hardware", label: "Hardware", appliesTo: ["source"] },
        { mode: "software", label: "duplicate", appliesTo: ["exception"] },
        { mode: "invalid", label: "No applicability", appliesTo: [] },
        { mode: "", label: "empty", appliesTo: ["source"] },
      ],
    });
    expect(modes).toEqual([
      {
        mode: "software",
        label: "Software",
        description: undefined,
        appliesTo: ["source", "data", "exception"],
      },
      {
        mode: "hardware",
        label: "Hardware",
        description: undefined,
        appliesTo: ["source"],
      },
    ]);
    expect(breakpointModesFor(modes, "source").map((mode) => mode.mode)).toEqual([
      "software",
      "hardware",
    ]);
    expect(resolveBreakpointMode(undefined, modes, "source")).toBe("software");
    expect(resolveBreakpointMode("hardware", modes, "source")).toBe("hardware");
    // A stale mode from another adapter is rejected in favor of the default.
    expect(resolveBreakpointMode("hardware", modes, "data")).toBe("software");
  });

  it("adds a source mode only when it is advertised for that adapter", () => {
    const plan = planBreakpointSync([{
      line: 8,
      adapterModes: { java: "hardware", node: "not-advertised" },
    }]);
    const modes = parseBreakpointModes({
      breakpointModes: [
        { mode: "software", label: "Software", appliesTo: ["source"] },
        { mode: "hardware", label: "Hardware", appliesTo: ["source"] },
      ],
    });
    expect(buildSetBreakpointsArgs("/repo/App.java", plan, {
      adapterId: "java",
      breakpointModes: modes,
    }).breakpoints).toEqual([{ line: 8, mode: "hardware" }]);
    expect(buildSetBreakpointsArgs("/repo/App.java", plan, {
      adapterId: "node",
      breakpointModes: modes,
    }).breakpoints).toEqual([{ line: 8, mode: "software" }]);
  });

  it("omits disabled and muted breakpoints from the request but keeps them stored", () => {
    const stored = [{ line: 5 }, { line: 9, enabled: false }, { line: 12 }];
    const plan = planBreakpointSync(stored);
    expect(plan.sent.map((bp) => bp.line)).toEqual([5, 12]);
    // `indexes` maps each sent entry back to its slot in the stored, sorted list.
    expect(plan.indexes).toEqual([0, 2]);
    expect(plan.sorted.map((bp) => bp.line)).toEqual([5, 9, 12]);
    // Muting suppresses every breakpoint without forgetting any of them.
    const muted = planBreakpointSync(stored, { muted: true });
    expect(muted.sent).toEqual([]);
    expect(muted.sorted).toHaveLength(3);
  });

  it("plans and builds standard function breakpoints with conditions", () => {
    const stored = [
      { name: "Service.run", condition: " ready " },
      { name: "Controller.handle", hitCondition: " 3 " },
      { name: "Worker.skip", enabled: false },
    ];
    const plan = planFunctionBreakpointSync(stored);
    expect(plan.sorted.map((breakpoint) => breakpoint.name)).toEqual([
      "Controller.handle",
      "Service.run",
      "Worker.skip",
    ]);
    expect(buildSetFunctionBreakpointsArgs(plan)).toEqual({
      breakpoints: [
        { name: "Controller.handle", hitCondition: "3" },
        { name: "Service.run", condition: "ready" },
      ],
    });
    expect(planFunctionBreakpointSync(stored, { muted: true }).sent).toEqual([]);
  });

  it("parses function-breakpoint verification by request order", () => {
    const plan = planFunctionBreakpointSync([
      { name: "Service.run" },
      { name: "Controller.handle" },
    ]);
    const bindings = parseSetFunctionBreakpointsResponse(plan, {
      breakpoints: [
        { id: 7, verified: true },
        { id: 8, verified: false, reason: "failed", message: "method not found" },
      ],
    });
    expect(bindings).toEqual([
      {
        id: 7,
        verified: true,
        name: "Controller.handle",
        message: null,
        reason: null,
      },
      {
        id: 8,
        verified: false,
        name: "Service.run",
        message: "method not found",
        reason: "failed",
      },
    ]);
    expect(functionBreakpointVerificationMap(plan, bindings)).toEqual({
      "Controller.handle": { status: "verified", message: null },
      "Service.run": { status: "failed", message: "method not found" },
    });
  });

  it("plans adapter-scoped instruction breakpoints with signed offsets and modes", () => {
    const stored = [
      {
        adapterId: "java",
        instructionReference: "0x1000",
        offset: -4,
        condition: " ready ",
        mode: "hardware",
      },
      {
        adapterId: "java",
        instructionReference: "0x1000",
        offset: 8,
        hitCondition: " 2 ",
        enabled: false,
      },
      { adapterId: "node", instructionReference: "main:entry" },
    ];
    const plan = planInstructionBreakpointSync(stored, { adapterId: "java" });
    expect(plan.applicable).toHaveLength(2);
    expect(plan.sent).toHaveLength(1);
    const modes = parseBreakpointModes({
      breakpointModes: [{ mode: "hardware", label: "Hardware", appliesTo: ["instruction"] }],
    });
    expect(buildSetInstructionBreakpointsArgs(plan, modes)).toEqual({
      breakpoints: [{
        instructionReference: "0x1000",
        offset: -4,
        condition: "ready",
        mode: "hardware",
      }],
    });
    expect(buildSetInstructionBreakpointsArgs(
      planInstructionBreakpointSync(stored, { adapterId: "node" }),
      modes,
    )).toEqual({ breakpoints: [{ instructionReference: "main:entry", mode: "hardware" }] });
    expect(planInstructionBreakpointSync(stored, { adapterId: "java", muted: true }).sent).toEqual([]);
  });

  it("maps instruction breakpoint bindings and rejects stale mode metadata", () => {
    const plan = planInstructionBreakpointSync([{
      adapterId: "java",
      instructionReference: "0x1000",
      offset: 2,
      mode: "not-advertised",
    }], { adapterId: "java" });
    const modes = parseBreakpointModes({
      breakpointModes: [{ mode: "software", label: "Software", appliesTo: ["instruction"] }],
    });
    expect(buildSetInstructionBreakpointsArgs(plan, modes)).toEqual({
      breakpoints: [{ instructionReference: "0x1000", offset: 2, mode: "software" }],
    });
    const bindings = parseSetInstructionBreakpointsResponse(plan, {
      breakpoints: [{ id: 91, verified: false, reason: "failed", message: "not executable" }],
    });
    expect(bindings).toEqual([{
      id: 91,
      verified: false,
      key: instructionBreakpointKey(plan.sent[0]),
      message: "not executable",
      reason: "failed",
    }]);
    expect(instructionBreakpointVerificationMap(plan, bindings)).toEqual({
      [instructionBreakpointKey(plan.sent[0])]: { status: "failed", message: "not executable" },
    });
  });

  it("discovers and scopes standard DAP data breakpoints", () => {
    expect(buildDataBreakpointInfoArgs({ name: "count", variablesReference: 17, frameId: 3, mode: "hardware" })).toEqual({
      name: "count",
      variablesReference: 17,
      mode: "hardware",
    });
    expect(buildDataBreakpointInfoArgs({ name: "service.count", frameId: 3 })).toEqual({
      name: "service.count",
      frameId: 3,
    });
    const info = parseDataBreakpointInfo({
      dataId: "field:Service.count",
      description: "Service.count",
      accessTypes: ["read", "write", "write", "invalid"],
      canPersist: true,
    });
    expect(info).toEqual({
      dataId: "field:Service.count",
      description: "Service.count",
      accessTypes: ["read", "write"],
      canPersist: true,
    });
    expect(defaultDataBreakpointAccessType(info.accessTypes)).toBe("write");
    expect(parseDataBreakpointInfo({ dataId: null, description: "not watchable" }).dataId).toBeNull();
  });

  it("builds capability-gated address and byte-range discovery arguments", () => {
    expect(buildDataBreakpointInfoArgs({
      name: "0x7fff0000",
      frameId: 3,
      bytes: 16,
      asAddress: true,
      mode: "hardware",
    })).toEqual({
      name: "0x7fff0000",
      asAddress: true,
      bytes: 16,
      mode: "hardware",
    });
    expect(buildDataBreakpointInfoArgs({
      name: "buffer",
      variablesReference: 17,
      frameId: 3,
      bytes: 8,
    })).toEqual({
      name: "buffer",
      variablesReference: 17,
      bytes: 8,
    });
    expect(buildDataBreakpointInfoArgs({ name: "buffer", bytes: 0 })).toEqual({ name: "buffer" });
  });

  it("builds replacing data-breakpoint requests and maps verification", () => {
    const stored = [
      {
        dataId: "field:count",
        description: "Service.count",
        adapterId: "java",
        accessTypes: ["read", "write"] as const,
        accessType: "write" as const,
        condition: " ready ",
        canPersist: true,
      },
      {
        dataId: "address:temp",
        description: "temporary",
        adapterId: "java",
        accessTypes: ["write"] as const,
        hitCondition: " 2 ",
        canPersist: false,
        sessionId: "session-1",
      },
      {
        dataId: "field:other",
        description: "Other.value",
        adapterId: "node",
        accessTypes: [] as const,
        canPersist: true,
      },
    ];
    const plan = planDataBreakpointSync(stored.map((entry) => ({
      ...entry,
      accessTypes: [...entry.accessTypes],
    })), {
      adapterId: "java",
      sessionId: "session-1",
    });
    expect(plan.applicable).toHaveLength(2);
    expect(buildSetDataBreakpointsArgs(plan)).toEqual({
      breakpoints: [
        { dataId: "field:count", accessType: "write", condition: "ready" },
        { dataId: "address:temp", hitCondition: "2" },
      ],
    });
    const bindings = parseSetDataBreakpointsResponse(plan, {
      breakpoints: [
        { id: 71, verified: true },
        { id: 72, verified: false, reason: "failed", message: "address expired" },
      ],
    });
    expect(bindings.map((binding) => binding.key)).toEqual(plan.sent.map(dataBreakpointKey));
    expect(dataBreakpointVerificationMap(plan, bindings)).toEqual({
      [dataBreakpointKey(plan.sent[0])]: { status: "verified", message: null },
      [dataBreakpointKey(plan.sent[1])]: { status: "failed", message: "address expired" },
    });
    expect(planDataBreakpointSync(plan.sorted, {
      adapterId: "java",
      sessionId: "session-1",
      muted: true,
    }).sent).toEqual([]);
  });

  it("places an advertised exception mode in filterOptions without inventing a condition", () => {
    const filters = parseExceptionBreakpointFilters({
      exceptionBreakpointFilters: [{ filter: "all", label: "All", default: true }],
    });
    const modes = parseBreakpointModes({
      breakpointModes: [{ mode: "hardware", label: "Hardware", appliesTo: ["exception"] }],
    });
    const plan = planExceptionBreakpointSync([
      { adapterId: "java", filterId: "all", enabled: true, mode: "hardware" },
    ], [], filters, {
      adapterId: "java",
      supportsFilterOptions: true,
      breakpointModes: modes,
    });
    expect(buildSetExceptionBreakpointsArgs(plan)).toEqual({
      filters: [],
      filterOptions: [{ filterId: "all", mode: "hardware" }],
    });
  });

  it("inserts a run-to-cursor breakpoint in line order without storing it", () => {
    const plan = planBreakpointSync([{ line: 3 }, { line: 20 }], { extraLine: 11 });
    expect(plan.sent.map((bp) => bp.line)).toEqual([3, 11, 20]);
    expect(plan.indexes).toEqual([0, -1, 1]);
    expect(plan.sorted.map((bp) => bp.line)).toEqual([3, 20]);
    // A transient line that already has a breakpoint is not duplicated.
    expect(planBreakpointSync([{ line: 3 }], { extraLine: 3 }).sent).toHaveLength(1);
    // Muted + run-to-cursor: only the transient one is armed.
    const muted = planBreakpointSync([{ line: 3 }], { muted: true, extraLine: 8 });
    expect(muted.sent.map((bp) => bp.line)).toEqual([8]);
  });

  it("parses setBreakpoints responses aligned to the sorted request order", () => {
    const plan = planBreakpointSync([{ line: 9 }, { line: 3 }]);
    const bindings = parseSetBreakpointsResponse(plan, {
      breakpoints: [
        { id: 1, verified: true, line: 4 },
        { id: 2, verified: false },
      ],
    });
    expect(bindings).toEqual([
      { id: 1, verified: true, line: 4, message: null, reason: null },
      { id: 2, verified: false, line: 9, message: null, reason: null },
    ]);
    // Missing/short response arrays leave breakpoints unverified on their line.
    expect(parseSetBreakpointsResponse(plan, null)).toEqual([
      { id: null, verified: false, line: 3, message: null, reason: null },
      { id: null, verified: false, line: 9, message: null, reason: null },
    ]);
  });
}
