import { expect, it } from "vitest";
import {
  appendConsoleLine,
  breakpointVerificationMap,
  buildSetExceptionBreakpointsArgs,
  currentLocation,
  exceptionBreakpointRuleLabel,
  exceptionBreakpointRuleVerificationMap,
  exceptionBreakpointVerificationMap,
  hoverExpressionAt,
  initialDebugState,
  inlineValueLabel,
  markResumed,
  mergeExceptionBreakpointDefaults,
  parseBreakpointEvent,
  parseEvaluate,
  parseExceptionBreakpointFilters,
  parseExceptionInfo,
  parseSetBreakpointsResponse,
  parseSetExceptionBreakpointsResponse,
  parseStackFrames,
  parseThreads,
  planBreakpointSync,
  planExceptionBreakpointSync,
  reconcileBreakpointLines,
  reduceDebugEvent,
  type DebugStackFrame,
} from "../../dapDebugModel";

export function registerdapDebugModelNavigation2Cases() {

  it("captures the adapter's message + reason for an unverified breakpoint", () => {
    const plan = planBreakpointSync([{ line: 7 }]);
    const [binding] = parseSetBreakpointsResponse(plan, {
      breakpoints: [{ id: 3, verified: false, line: 7, message: "No code at line 7", reason: "failed" }],
    });
    expect(binding).toEqual({
      id: 3,
      verified: false,
      line: 7,
      message: "No code at line 7",
      reason: "failed",
    });
  });

  it("adopts adapter-adjusted breakpoint lines and drops collapsed duplicates", () => {
    const plan = planBreakpointSync([{ line: 3, condition: "x" }, { line: 5 }]);
    // The adapter moved line 3 → 5 (line 3 was not executable): both collapse to 5.
    const moved = reconcileBreakpointLines(plan, [
      { id: 1, verified: true, line: 5 },
      { id: 2, verified: true, line: 5 },
    ]);
    expect(moved).toEqual([{ line: 5, condition: "x" }]);
    // Unverified bindings do not move the breakpoint.
    const kept = reconcileBreakpointLines(plan, [
      { id: 1, verified: false, line: 7 },
      { id: 2, verified: true, line: 5 },
    ]);
    expect(kept).toEqual([{ line: 3, condition: "x" }, { line: 5 }]);
  });

  it("keeps unsent breakpoints intact when reconciling a partial request", () => {
    // Disabled entries are not in the response; they must survive untouched and
    // must not consume a binding meant for the next enabled breakpoint.
    const plan = planBreakpointSync([{ line: 3 }, { line: 5, enabled: false }, { line: 9 }]);
    const reconciled = reconcileBreakpointLines(plan, [
      { id: 1, verified: true, line: 4 },
      { id: 2, verified: true, line: 10 },
    ]);
    expect(reconciled).toEqual([{ line: 4 }, { line: 5, enabled: false }, { line: 10 }]);
  });

  it("reports verification per bound line for the gutter", () => {
    const plan = planBreakpointSync([{ line: 3 }, { line: 5, enabled: false }, { line: 9 }]);
    const map = breakpointVerificationMap(plan, [
      { id: 1, verified: true, line: 4 },
      { id: 2, verified: false, line: 9, reason: "failed", message: "no code" },
    ]);
    // Keyed by the line the adapter bound; the disabled breakpoint has no entry.
    // Verified → verified; unverified+failed → failed (carries the reason).
    expect(map).toEqual({
      4: { status: "verified", message: null },
      9: { status: "failed", message: "no code" },
    });
  });

  it("parses breakpoint events (verification changes as classes load)", () => {
    expect(parseBreakpointEvent({
      body: { reason: "changed", breakpoint: { id: 7, verified: true, line: 12 } },
    })).toEqual({ reason: "changed", id: 7, verified: true, line: 12, message: null, bindReason: null });
    // An unverified re-bind carries the adapter's reason + message for the UI.
    expect(parseBreakpointEvent({
      body: {
        reason: "changed",
        breakpoint: { id: 8, verified: false, line: 20, reason: "failed", message: "class not loaded" },
      },
    })).toEqual({
      reason: "changed",
      id: 8,
      verified: false,
      line: 20,
      message: "class not loaded",
      bindReason: "failed",
    });
    expect(parseBreakpointEvent({ body: {} })).toBeNull();
    expect(parseBreakpointEvent(null)).toBeNull();
  });

  it("parses exception filters and seeds adapter defaults without overriding choices", () => {
    const caps = {
      exceptionBreakpointFilters: [
        {
          filter: "caught",
          label: "Caught Exceptions",
          description: "Pause on handled exceptions",
          default: true,
          supportsCondition: true,
          conditionDescription: "Exception class or expression",
        },
        { filter: "uncaught", label: "Uncaught Exceptions" },
        { filter: "caught", label: "duplicate" },
        { label: "invalid" },
      ],
    };
    const filters = parseExceptionBreakpointFilters(caps);
    expect(filters).toEqual([
      {
        filter: "caught",
        label: "Caught Exceptions",
        description: "Pause on handled exceptions",
        default: true,
        supportsCondition: true,
        conditionDescription: "Exception class or expression",
      },
      {
        filter: "uncaught",
        label: "Uncaught Exceptions",
        description: undefined,
        default: false,
        supportsCondition: false,
        conditionDescription: undefined,
      },
    ]);
    const seeded = mergeExceptionBreakpointDefaults([
      { adapterId: "java", filterId: "caught", enabled: false },
      { adapterId: "node", filterId: "all", enabled: true },
    ], "java", filters);
    expect(seeded).toEqual([
      { adapterId: "java", filterId: "caught", enabled: false },
      { adapterId: "node", filterId: "all", enabled: true },
      { adapterId: "java", filterId: "uncaught", enabled: false },
    ]);
    expect(mergeExceptionBreakpointDefaults(seeded, "java", filters)).toBe(seeded);
    expect(parseExceptionBreakpointFilters({})).toEqual([]);
  });

  it("builds conditional exception filters with a legacy fallback and positional bindings", () => {
    const filters = parseExceptionBreakpointFilters({
      exceptionBreakpointFilters: [
        { filter: "caught", label: "Caught", supportsCondition: true },
        { filter: "uncaught", label: "Uncaught" },
      ],
    });
    const settings = [
      { adapterId: "java", filterId: "caught", enabled: true, condition: " IOException " },
      { adapterId: "java", filterId: "uncaught", enabled: true },
      { adapterId: "node", filterId: "caught", enabled: true },
    ];
    const rules = [
      {
        id: "java-io",
        adapterId: "java",
        path: [
          { names: ["Java Exceptions"] },
          { names: ["java.io.IOException", "java.sql.SQLException"] },
          { names: ["sun.*"], negate: true },
        ],
        breakMode: "unhandled" as const,
        enabled: true,
      },
      {
        id: "node-error",
        adapterId: "node",
        path: [{ names: ["Error"] }],
        breakMode: "always" as const,
        enabled: true,
      },
    ];
    const plan = planExceptionBreakpointSync(settings, rules, filters, {
      adapterId: "java",
      supportsFilterOptions: true,
      supportsExceptionOptions: true,
    });
    expect(buildSetExceptionBreakpointsArgs(plan)).toEqual({
      filters: ["uncaught"],
      filterOptions: [{ filterId: "caught", condition: "IOException" }],
      exceptionOptions: [{
        path: [
          { names: ["Java Exceptions"] },
          { names: ["java.io.IOException", "java.sql.SQLException"] },
          { names: ["sun.*"], negate: true },
        ],
        breakMode: "unhandled",
      }],
    });
    expect(plan.sent.map((target) => (
      target.kind === "filter" ? target.breakpoint.filterId : target.rule.id
    ))).toEqual(["uncaught", "caught", "java-io"]);
    expect(exceptionBreakpointRuleLabel(rules[0])).toBe(
      "Java Exceptions / java.io.IOException | java.sql.SQLException / not (sun.*)",
    );
    expect(exceptionBreakpointRuleLabel({ path: [] })).toBe("All exceptions");

    const bindings = parseSetExceptionBreakpointsResponse(plan, {
      breakpoints: [
        { id: 7, verified: true },
        { id: 8, verified: false, reason: "failed", message: "Invalid condition" },
        { id: 9, verified: false, reason: "pending", message: "Class not loaded" },
      ],
    });
    expect(bindings.map((binding) => (
      binding.kind === "filter" ? binding.filterId : binding.ruleId
    ))).toEqual(["uncaught", "caught", "java-io"]);
    expect(exceptionBreakpointVerificationMap(plan, bindings)).toEqual({
      uncaught: { status: "verified", message: null },
      caught: { status: "failed", message: "Invalid condition" },
    });
    expect(exceptionBreakpointRuleVerificationMap(plan, bindings)).toEqual({
      "java-io": { status: "pending", message: "Class not loaded" },
    });

    const legacy = planExceptionBreakpointSync(settings, rules, filters, {
      adapterId: "java",
      supportsFilterOptions: false,
      supportsExceptionOptions: false,
    });
    expect(buildSetExceptionBreakpointsArgs(legacy)).toEqual({ filters: ["caught", "uncaught"] });
    expect(legacy.applicableRules).toEqual([rules[0]]);
    const muted = planExceptionBreakpointSync(settings, rules, filters, {
      adapterId: "java",
      muted: true,
      supportsFilterOptions: true,
      supportsExceptionOptions: true,
    });
    expect(buildSetExceptionBreakpointsArgs(muted)).toEqual({ filters: [] });
  });

  it("parses threads and stack frames tolerantly", () => {
    expect(parseThreads({ threads: [{ id: 1, name: "main" }, { name: "x" }] }))
      .toEqual([{ id: 1, name: "main" }]);
    const frames = parseStackFrames({
      stackFrames: [
        { id: 3, name: "App.main", source: { path: "/repo/App.java" }, line: 9, column: 2 },
        { id: 4, name: "native", line: 0 },
        // A library frame: no readable path, fetched via the `source` request.
        {
          id: 5,
          name: "java.util.ArrayList.get",
          source: { name: "ArrayList.java", sourceReference: 1001 },
          line: 427,
        },
      ],
    });
    expect(frames).toHaveLength(3);
    expect(frames[0].path).toBe("/repo/App.java");
    expect(frames[0].sourceReference).toBe(0);
    expect(frames[1].path).toBeNull();
    expect(frames[2]).toMatchObject({
      path: null,
      sourceReference: 1001,
      sourceName: "ArrayList.java",
      line: 427,
    });
  });

  it("parses exceptionInfo and evaluate responses", () => {
    expect(parseExceptionInfo({
      exceptionId: "java.lang.NullPointerException",
      description: "boom",
      details: { stackTrace: "at App.main(App.java:9)" },
    })).toEqual({
      exceptionId: "java.lang.NullPointerException",
      description: "boom",
      details: "at App.main(App.java:9)",
    });
    expect(parseExceptionInfo({})).toBeNull();

    expect(parseEvaluate({ result: "42", variablesReference: 5, type: "int" }))
      .toEqual({ value: "42", variablesReference: 5, type: "int" });
    expect(parseEvaluate(null)).toEqual({ value: "", variablesReference: 0, type: null });
  });

  it("derives the current highlight location from the selected frame, else the top frame", () => {
    const frames: DebugStackFrame[] = [
      { id: 1, name: "native", path: null, line: 0, column: 0, sourceReference: 0, sourceName: null },
      { id: 2, name: "App.main", path: "/repo/App.java", line: 9, column: 1, sourceReference: 0, sourceName: null },
      { id: 3, name: "App.run", path: "/repo/Run.java", line: 30, column: 1, sourceReference: 0, sourceName: null },
    ];
    expect(currentLocation(frames)).toEqual({ path: "/repo/App.java", line: 9 });
    expect(currentLocation(frames, 3)).toEqual({ path: "/repo/Run.java", line: 30 });
    // A pathless selected frame falls back to the top frame with a path.
    expect(currentLocation(frames, 1)).toEqual({ path: "/repo/App.java", line: 9 });
    expect(currentLocation([])).toBeNull();
  });

  it("reduces stopped / continued / terminated / output events", () => {
    let state = initialDebugState("s1");
    state = reduceDebugEvent(state, "stopped", { body: { threadId: 7, reason: "breakpoint" } });
    expect(state.status).toBe("stopped");
    expect(state.stoppedThreadId).toBe(7);
    expect(state.selectedThreadId).toBe(7);
    expect(state.stoppedReason).toBe("breakpoint");

    state = reduceDebugEvent(state, "output", { body: { output: "hello\n", category: "stderr" } });
    expect(state.output).toEqual([{ category: "stderr", text: "hello\n" }]);

    state = reduceDebugEvent(state, "continued", { body: {} });
    expect(state.status).toBe("running");
    expect(state.stoppedThreadId).toBeNull();
    expect(state.frames).toEqual([]);

    state = reduceDebugEvent(state, "terminated", {});
    expect(state.status).toBe("terminated");
  });

  it("marks resumed state: clears stack, selection, and exception details", () => {
    const stopped = {
      ...initialDebugState("s1"),
      status: "stopped" as const,
      stoppedThreadId: 1,
      stoppedReason: "breakpoint",
      frames: [{ id: 9, name: "f", path: "/a.java", line: 1, column: 1, sourceReference: 0, sourceName: null }],
      selectedThreadId: 1,
      selectedFrameId: 9,
      exceptionInfo: { exceptionId: "E", description: "", details: null },
    };
    const resumed = markResumed(stopped);
    expect(resumed.status).toBe("running");
    expect(resumed.frames).toEqual([]);
    expect(resumed.selectedFrameId).toBeNull();
    expect(resumed.exceptionInfo).toBeNull();
  });

  it("logs the process exit code on the exited event (IDEA-style)", () => {
    const state = reduceDebugEvent(initialDebugState("s1"), "exited", { body: { exitCode: 3 } });
    expect(state.status).toBe("terminated");
    expect(state.output.at(-1)?.text).toContain("exit code 3");
  });

  it.each(["terminated", "exited"] as const)(
    "clears the whole inspectable stack on %s and keeps the console",
    (event) => {
      const stopped = {
        ...initialDebugState("s1"),
        status: "stopped" as const,
        stoppedThreadId: 1,
        stoppedReason: "breakpoint",
        threads: [{ id: 1, name: "main" }, { id: 2, name: "worker" }],
        frames: [{ id: 9, name: "f", path: "/a.java", line: 1, column: 1, sourceReference: 0, sourceName: null }],
        selectedThreadId: 1,
        selectedFrameId: 9,
        exceptionInfo: { exceptionId: "E", description: "", details: null },
        output: [{ category: "stdout", text: "hello\n" }],
      };

      const ended = reduceDebugEvent(stopped, event, { body: {} });
      expect(ended.status).toBe("terminated");
      expect(ended.threads).toEqual([]);
      expect(ended.frames).toEqual([]);
      expect(ended.stoppedThreadId).toBeNull();
      expect(ended.stoppedReason).toBeNull();
      expect(ended.selectedThreadId).toBeNull();
      expect(ended.selectedFrameId).toBeNull();
      expect(ended.exceptionInfo).toBeNull();
      // Console history is the one thing Stop keeps (IDEA does the same).
      expect(ended.output).toEqual([{ category: "stdout", text: "hello\n" }]);
    },
  );

  it("appends client console lines and skips telemetry output", () => {
    let state = initialDebugState("s1");
    state = appendConsoleLine(state, "repl", "> 1 + 1\n");
    expect(state.output).toEqual([{ category: "repl", text: "> 1 + 1\n" }]);
    expect(appendConsoleLine(state, "repl", "")).toBe(state);
    expect(reduceDebugEvent(state, "output", { body: { output: "x", category: "telemetry" } })).toBe(state);
  });

  it("ignores unknown events and empty output", () => {
    const state = initialDebugState("s1");
    expect(reduceDebugEvent(state, "module", {})).toBe(state);
    expect(reduceDebugEvent(state, "output", { body: { output: "" } })).toBe(state);
  });

  it("tracks threads as the adapter starts and exits them", () => {
    // `threads` may only be requested while stopped, so the running thread list
    // is maintained from the events.
    let state = initialDebugState("s1");
    state = reduceDebugEvent(state, "thread", { body: { reason: "started", threadId: 4 } });
    state = reduceDebugEvent(state, "thread", { body: { reason: "started", threadId: 7 } });
    expect(state.threads.map((t) => t.id)).toEqual([4, 7]);
    // A repeated start is not a duplicate row.
    expect(reduceDebugEvent(state, "thread", { body: { reason: "started", threadId: 4 } })).toBe(state);
    state = reduceDebugEvent(state, "thread", { body: { reason: "exited", threadId: 4 } });
    expect(state.threads.map((t) => t.id)).toEqual([7]);
    // A malformed thread event changes nothing.
    expect(reduceDebugEvent(state, "thread", { body: {} })).toBe(state);
  });

  it("extracts the hovered expression, including dotted chains and indexes", () => {
    const line = "    total = order.items.get(i) + prices[i];";
    expect(hoverExpressionAt(line, line.indexOf("total") + 2)).toBe("total");
    // A dotted chain resolves to the full receiver path under the caret.
    expect(hoverExpressionAt(line, line.indexOf("items") + 1)).toBe("order.items");
    // An index directly after the identifier belongs to the expression.
    expect(hoverExpressionAt(line, line.indexOf("prices") + 1)).toBe("prices[i]");
    // Whitespace, operators and numeric literals are not expressions.
    expect(hoverExpressionAt(line, 1)).toBeNull();
    expect(hoverExpressionAt("x + 42", 4)).toBeNull();
    expect(hoverExpressionAt("x", -1)).toBeNull();
  });

  it("builds an inline value label from the locals mentioned on a line", () => {
    const variables = { sum: "10", i: "3", other: "9" };
    expect(inlineValueLabel("sum += values[i];", variables)).toBe("sum: 10, i: 3");
    // Field access is not the local of the same name, and comments are ignored.
    expect(inlineValueLabel("node.sum = 1; // i", variables)).toBeNull();
    // Each variable appears once even when mentioned twice.
    expect(inlineValueLabel("i = i + 1;", variables)).toBe("i: 3");
    expect(inlineValueLabel("System.out.println();", variables)).toBeNull();
    expect(inlineValueLabel("sum = 1;", {})).toBeNull();
  });

  it("enforces 10,000 lines limit in appendConsoleLine (D7.4)", () => {
    let state = initialDebugState("s1");
    for (let i = 0; i < 10050; i++) {
      state = appendConsoleLine(state, "stdout", `line ${i}\n`, i);
    }
    expect(state.output).toHaveLength(10000);
    expect(state.output[0]?.text).toBe("line 50\n");
    expect(state.output[9999]?.text).toBe("line 10049\n");
  });

  it("enforces 2 MiB memory budget eviction in appendConsoleLine (D7.4)", () => {
    let state = initialDebugState("s1");
    // Append 3 lines each of 1 MiB (1,000,000 chars)
    const bigLine1 = "a".repeat(1000000);
    const bigLine2 = "b".repeat(1000000);
    const bigLine3 = "c".repeat(1000000);

    state = appendConsoleLine(state, "stdout", bigLine1, 1);
    state = appendConsoleLine(state, "stdout", bigLine2, 2);
    // At this point total is 2 MiB -> holds both lines
    expect(state.output).toHaveLength(2);

    state = appendConsoleLine(state, "stdout", bigLine3, 3);
    // Adding 3rd line exceeds 2 MiB -> line 1 must be evicted
    expect(state.output).toHaveLength(2);
    expect(state.output[0]?.text).toBe(bigLine2);
    expect(state.output[1]?.text).toBe(bigLine3);
  });
}
