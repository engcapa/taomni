import { describe, expect, it } from "vitest";
import { EditorState } from "@codemirror/state";
import { CompletionContext, type CompletionResult } from "@codemirror/autocomplete";
import { hbaseCompletionSource, type HBaseCompletionContext } from "./hbaseCompletions";

/**
 * Run the completion source against `doc`, with the cursor placed at the `‸`
 * marker (which is stripped from the document before completion).
 */
function complete(
  doc: string,
  opts: HBaseCompletionContext,
  explicit = false,
): CompletionResult | null {
  const pos = doc.indexOf("‸");
  const text = doc.replace("‸", "");
  const state = EditorState.create({ doc: text });
  const context = new CompletionContext(state, pos < 0 ? text.length : pos, explicit);
  return hbaseCompletionSource(opts)(context) as CompletionResult | null;
}

const labels = (r: CompletionResult | null): string[] =>
  (r?.options ?? []).map((o) => o.label);

describe("hbaseCompletionSource", () => {
  it("suggests HBase shell command verbs at the start of a statement", () => {
    const result = complete("sc‸", { transport: "native" });
    expect(labels(result)).toContain("scan");
    expect(labels(result)).toContain("status");
    // Never offers SQL keywords.
    expect(labels(result)).not.toContain("SELECT");
    expect(labels(result)).not.toContain("FROM");
  });

  it("offers every supported verb at command position", () => {
    const result = complete("‸", { transport: "native" }, true);
    const verbs = labels(result);
    for (const verb of ["get", "put", "scan", "list", "describe", "create", "drop", "count", "exists"]) {
      expect(verbs).toContain(verb);
    }
  });

  it("hides admin-only verbs on the REST transport", () => {
    const verbs = labels(complete("‸", { transport: "rest" }, true));
    expect(verbs).not.toContain("alter");
    expect(verbs).not.toContain("enable");
    expect(verbs).not.toContain("disable");
    // Non-admin verbs remain available.
    expect(verbs).toContain("scan");
    expect(verbs).toContain("get");
  });

  it("includes admin-only verbs on native/thrift transports", () => {
    for (const transport of ["native", "thrift"] as const) {
      const verbs = labels(complete("‸", { transport }, true));
      expect(verbs).toContain("alter");
      expect(verbs).toContain("enable");
      expect(verbs).toContain("disable");
    }
  });

  it("never suggests unsupported verbs like truncate", () => {
    const verbs = labels(complete("‸", { transport: "native" }, true));
    expect(verbs).not.toContain("truncate");
  });

  it("suggests option-map keywords inside a command's arguments", () => {
    const result = complete("scan 'tbl', {LIM‸", { transport: "native" });
    expect(labels(result)).toContain("LIMIT");
    // Not command verbs when past the verb.
    expect(labels(result)).not.toContain("scan");
  });

  it("suggests table names from the loaded schema at argument position", () => {
    const result = complete("scan 'us‸", {
      transport: "native",
      schema: { users: ["cf1"], orders: ["data"] },
    });
    const opts = labels(result);
    expect(opts).toContain("users");
    expect(opts).toContain("orders");
    expect(opts).toContain("cf1");
    expect(opts).toContain("data");
  });

  it("treats a statement after a top-level ';' as a new command", () => {
    const result = complete("list; sc‸", { transport: "native" });
    expect(labels(result)).toContain("scan");
  });

  it("inserts only the verb, not a full example template", () => {
    const result = complete("sca‸", { transport: "native" });
    const scan = result?.options.find((o) => o.label === "scan");
    expect(scan?.apply).toBe("scan");
  });

  it("returns null on an empty word unless explicitly triggered", () => {
    expect(complete("scan 'tbl' ‸", { transport: "native" }, false)).toBeNull();
    expect(complete("scan 'tbl' ‸", { transport: "native" }, true)).not.toBeNull();
  });
});
