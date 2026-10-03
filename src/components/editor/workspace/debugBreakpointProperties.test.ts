import { describe, expect, it } from "vitest";
import {
  adapterLogMessage,
  buildSetBreakpointsArgs,
  effectiveSuspend,
  planBreakpointSync,
  type DebugStackFrame,
} from "./dapDebugModel";
import {
  breakpointHitLogText,
  breakpointMasterKeys,
  breakpointRefKey,
  breakpointTooltipLines,
  dependentsOf,
  frameLabelText,
  frameListEntries,
  hasClientNonSuspending,
  logTemplateParts,
  masterOf,
  needsClientHit,
  threadLabelText,
  variableValueText,
} from "./debugBreakpointProperties";

const PATH = "/ws/src/main/java/com/acme/App.java";

function frame(id: number, name: string, path: string | null, line: number): DebugStackFrame {
  return { id, name, path, line, column: 1, sourceReference: path ? 0 : 7, sourceName: path ? null : "Thread.java" };
}

describe("IDEA breakpoint semantics", () => {
  it("keeps stored logpoints non-suspending and every other breakpoint suspending", () => {
    expect(effectiveSuspend({ line: 3 })).toBe(true);
    expect(effectiveSuspend({ line: 3, logMessage: "x={x}" })).toBe(false);
    expect(effectiveSuspend({ line: 3, logMessage: "x={x}", suspend: true })).toBe(true);
    expect(effectiveSuspend({ line: 3, suspend: false })).toBe(false);
  });

  it("sends non-suspending logging breakpoints to the adapter as logpoints", () => {
    expect(adapterLogMessage({ line: 7, suspend: false, logHitMessage: true, logExpression: "i" }, PATH))
      .toBe("Breakpoint reached at App.java:7\n{i}");
    expect(adapterLogMessage({ line: 7, logHitMessage: true }, PATH)).toBeNull();
    const plan = planBreakpointSync([
      { line: 7, suspend: false, logHitMessage: true },
      { line: 9, suspend: false },
      { line: 11, condition: "i > 2" },
    ], { path: PATH });
    // The non-suspending breakpoint with nothing to do is not armed at all.
    expect(plan.sent.map((bp) => bp.line)).toEqual([7, 11]);
    expect(buildSetBreakpointsArgs(PATH, plan).breakpoints).toEqual([
      { line: 7, logMessage: "Breakpoint reached at App.java:7" },
      { line: 11, condition: "i > 2" },
    ]);
  });

  it("lets the adapter suspend client-managed breakpoints and holds dependents until armed", () => {
    const map = {
      [PATH]: [
        { line: 5 },
        { line: 8, dependsOn: { path: PATH, line: 5 } },
        { line: 12, suspend: false, logStack: true },
      ],
    };
    const masters = breakpointMasterKeys(map);
    expect([...masters]).toEqual([breakpointRefKey(PATH, 5)]);
    expect(dependentsOf({ path: PATH, line: 5 }, map)).toEqual([{ path: PATH, line: 8 }]);
    const armed = new Set<string>();
    const plan = () => planBreakpointSync(map[PATH], {
      path: PATH,
      isArmed: (bp) => !masterOf(bp, map) || armed.has(breakpointRefKey(PATH, bp.line)),
      clientManaged: (bp) => needsClientHit(bp, masters.has(breakpointRefKey(PATH, bp.line))),
    });
    expect(buildSetBreakpointsArgs(PATH, plan()).breakpoints).toEqual([{ line: 5 }, { line: 12 }]);
    armed.add(breakpointRefKey(PATH, 8));
    expect(plan().sent.map((bp) => bp.line)).toEqual([5, 8, 12]);
    expect(hasClientNonSuspending(map)).toBe(true);
    expect(hasClientNonSuspending({ [PATH]: [{ line: 5 }] })).toBe(false);
  });

  it("treats a dependency on a removed master as a plain breakpoint", () => {
    const map = { [PATH]: [{ line: 8, dependsOn: { path: PATH, line: 5 } }] };
    expect(masterOf(map[PATH][0], map)).toBeNull();
    expect(breakpointMasterKeys(map).size).toBe(0);
  });

  it("prints the IDEA hit message, stack trace and evaluated values", () => {
    const frames = [
      frame(1, "com.acme.App.compute(int)", PATH, 12),
      frame(2, "com.acme.App.main(String[])", PATH, 5),
    ];
    expect(breakpointHitLogText({ line: 12, logHitMessage: true }, frames))
      .toBe("Breakpoint reached at com.acme.App.compute(App.java:12)\n");
    expect(breakpointHitLogText({ line: 12, logStack: true }, frames, { expression: "42" })).toBe(
      "Breakpoint reached\n\tat com.acme.App.compute(App.java:12)\n\tat com.acme.App.main(App.java:5)\n42\n",
    );
    expect(breakpointHitLogText({ line: 12 }, frames)).toBe("");
    expect(logTemplateParts("i={i}, n={ list.size() }")).toEqual([
      { text: "i=" }, { expression: "i" }, { text: ", n=" }, { expression: "list.size()" },
    ]);
  });

  it("describes a breakpoint the way IDEA's gutter tooltip does", () => {
    expect(breakpointTooltipLines({
      line: 12,
      condition: "i > 2",
      temporary: true,
      suspend: false,
      logHitMessage: true,
      dependsOn: { path: PATH, line: 5 },
    }, PATH)).toEqual([
      "Line breakpoint: App.java:12",
      "Suspend: none",
      "Condition: i > 2",
      "Log message: yes",
      "Remove once hit",
      "Depends on: App.java:5",
    ]);
  });
});

describe("IDEA frame, thread and value labels", () => {
  it("formats frames as method:line, Class (package)", () => {
    expect(frameLabelText(frame(1, "com.acme.App.compute(int)", PATH, 12))).toBe("compute:12, App (com.acme)");
    expect(frameLabelText(frame(1, "App.main(String[])", PATH, 5))).toBe("main:5, App (com.acme)");
    expect(frameLabelText(frame(1, "<anonymous>", null, 0))).toBe("<anonymous>");
  });

  it("folds consecutive library frames but never the top frame", () => {
    const frames = [
      frame(1, "java.lang.Thread.sleep(long)", null, 0),
      frame(2, "com.acme.App.run()", PATH, 20),
      frame(3, "java.util.X.a()", null, 0),
      frame(4, "java.util.X.b()", null, 0),
      frame(5, "com.acme.App.main(String[])", PATH, 5),
    ];
    expect(frameListEntries(frames, true).map((entry) => (
      entry.kind === "frame" ? entry.frame.id : `+${entry.count}`
    ))).toEqual([1, 2, "+2", 5]);
    expect(frameListEntries(frames, false)).toHaveLength(5);
  });

  it("labels threads and object values like IDEA", () => {
    expect(threadLabelText({ id: 1, name: "Thread [main]" }, true)).toBe('"main"@1: SUSPENDED');
    expect(threadLabelText({ id: 14, name: "worker" }, false)).toBe('"worker"@14: RUNNING');
    expect(variableValueText("ArrayList@23 size=3")).toBe("{ArrayList@23} size=3");
    expect(variableValueText("App@7")).toBe("{App@7}");
    expect(variableValueText("\"text\"")).toBe("\"text\"");
    expect(variableValueText("42")).toBe("42");
  });
});
