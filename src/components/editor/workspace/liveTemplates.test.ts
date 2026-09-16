import { afterEach, describe, expect, it } from "vitest";
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { CompletionContext } from "@codemirror/autocomplete";
import {
  DEFAULT_LIVE_TEMPLATE_PREFERENCES,
  LIVE_TEMPLATE_PREFERENCES_STORAGE_KEY,
  saveLiveTemplatePreferences,
} from "../../../lib/liveTemplatePreferences";
import {
  createLiveTemplateCompletionSource,
  expandLiveTemplateAt,
  listLiveTemplateCompletions,
  liveTemplateLanguageForPath,
  matchLiveTemplateAbbreviation,
  matchPostfixTemplate,
  materializeTemplateBody,
  plainTemplateAbbreviations,
  providerOwnedExactAbbreviationAt,
  providerSnippetAbbreviations,
  refreshLiveTemplatePreferencesCache,
  LIVE_TEMPLATES,
} from "./liveTemplates";

afterEach(() => {
  window.localStorage.removeItem(LIVE_TEMPLATE_PREFERENCES_STORAGE_KEY);
  refreshLiveTemplatePreferencesCache({
    ...DEFAULT_LIVE_TEMPLATE_PREFERENCES,
    customTemplates: [],
  });
});

function docAt(text: string, pos = text.length) {
  const state = EditorState.create({ doc: text });
  return { state, pos };
}

function makeView(doc: string, head = doc.length) {
  const parent = document.createElement("div");
  document.body.appendChild(parent);
  const view = new EditorView({
    state: EditorState.create({
      doc,
      selection: { anchor: head },
    }),
    parent,
  });
  return view;
}

describe("liveTemplateLanguageForPath", () => {
  it("maps common extensions", () => {
    expect(liveTemplateLanguageForPath("src/Main.java")).toBe("java");
    expect(liveTemplateLanguageForPath("a.kt")).toBe("kotlin");
    expect(liveTemplateLanguageForPath("app.tsx")).toBe("typescript");
    expect(liveTemplateLanguageForPath("lib.rs")).toBe("rust");
    expect(liveTemplateLanguageForPath("main.go")).toBe("go");
    expect(liveTemplateLanguageForPath("README.md")).toBe("generic");
  });
});

describe("Java live templates", () => {
  it("matches sout / psvm / fori abbreviations", () => {
    const { state, pos } = docAt("    sout");
    const match = matchLiveTemplateAbbreviation(state.doc, pos, "java");
    expect(match?.template.abbreviation).toBe("sout");
    expect(match?.exact).toBe(true);
    expect(materializeTemplateBody(match!.template)).toBe("System.out.println(${});");

    const psvm = matchLiveTemplateAbbreviation(docAt("psvm").state.doc, 4, "java");
    expect(psvm?.template.abbreviation).toBe("psvm");
    expect(psvm?.template.body).toContain("public static void main");

    const fori = matchLiveTemplateAbbreviation(docAt("fori").state.doc, 4, "java");
    expect(fori?.template.abbreviation).toBe("fori");
  });

  it("lists prefix matches so soutv is available while typing sout", () => {
    const { state, pos } = docAt("sout");
    const listed = listLiveTemplateCompletions(state.doc, pos, "java");
    const abbrs = listed?.matches.map((m) => m.template.abbreviation) ?? [];
    expect(abbrs).toEqual(expect.arrayContaining(["sout", "soutm", "soutp", "soutv"]));
  });

  it("does not treat member access as a live template abbreviation", () => {
    const { state, pos } = docAt("obj.sout");
    // plain matcher should refuse (dot before word); postfix handles it
    expect(matchLiveTemplateAbbreviation(state.doc, pos, "java")).toBeNull();
  });

  it("matches postfix value.sout", () => {
    const { state, pos } = docAt("value.sout");
    const match = matchPostfixTemplate(state.doc, pos, "java");
    expect(match?.exact).toBe(true);
    expect(match?.expr).toBe("value");
    expect(materializeTemplateBody(match!.template, match!.expr))
      .toBe("System.out.println(value);");
  });

  it("matches chained postfix foo.bar.sout", () => {
    const match = matchPostfixTemplate(docAt("foo.bar.sout").state.doc, 11, "java");
    expect(match?.expr).toBe("foo.bar");
    expect(materializeTemplateBody(match!.template, match!.expr))
      .toBe("System.out.println(foo.bar);");
  });
});

describe("createLiveTemplateCompletionSource", () => {
  it("offers Java templates while typing an abbreviation", () => {
    const source = createLiveTemplateCompletionSource(() => "App.java");
    const state = EditorState.create({ doc: "sout" });
    const result = source(new CompletionContext(state, 4, false));
    expect(result).not.toBeNull();
    if (!result || "then" in result) throw new Error("expected sync result");
    const labels = result.options.map((o) => o.label);
    expect(labels).toContain("sout");
    expect(result.options[0]?.boost).toBeGreaterThan(400);
  });

  it("returns null for unrelated languages without matching templates", () => {
    const source = createLiveTemplateCompletionSource(() => "notes.md");
    const state = EditorState.create({ doc: "sout" });
    const result = source(new CompletionContext(state, 4, false));
    // generic language has no sout template
    expect(result).toBeNull();
  });

  it("offers JS console templates for .ts files", () => {
    const source = createLiveTemplateCompletionSource(() => "src/a.ts");
    const state = EditorState.create({ doc: "clg" });
    const result = source(new CompletionContext(state, 3, false));
    expect(result).not.toBeNull();
    if (!result || "then" in result) throw new Error("expected sync result");
    expect(result.options.some((o) => o.label === "clg")).toBe(true);
  });

  it("suppresses live templates when typing inside string literals", () => {
    const source = createLiveTemplateCompletionSource(() => "App.java");
    const doc = 'String firstStr = "this is another ";';
    const state = EditorState.create({ doc });
    const pos = doc.indexOf("another") + 2;
    const result = source(new CompletionContext(state, pos, false));
    expect(result).toBeNull();
  });

  it("suppresses live templates for 1-char non-exact prefix during automatic typing", () => {
    const source = createLiveTemplateCompletionSource(() => "App.java");
    // "s" is a prefix of "sout", but typing "s" alone should not trigger completion popup
    const state = EditorState.create({ doc: "s" });
    const result = source(new CompletionContext(state, 1, false));
    expect(result).toBeNull();

    // But typing exact abbreviation "if" should trigger completion
    const ifState = EditorState.create({ doc: "if" });
    const ifResult = source(new CompletionContext(ifState, 2, false));
    expect(ifResult).not.toBeNull();
  });
});

describe("expandLiveTemplateAt", () => {
  it("expands sout with Tab-equivalent call", () => {
    const view = makeView("sout");
    expect(expandLiveTemplateAt(view, "java")).toBe(true);
    expect(view.state.doc.toString()).toBe("System.out.println();");
    view.destroy();
  });

  it("expands postfix list.sout", () => {
    const view = makeView("list.sout");
    expect(expandLiveTemplateAt(view, "java")).toBe(true);
    expect(view.state.doc.toString()).toBe("System.out.println(list);");
    view.destroy();
  });

  it("does not expand incomplete abbreviations", () => {
    const view = makeView("sou");
    expect(expandLiveTemplateAt(view, "java")).toBe(false);
    expect(view.state.doc.toString()).toBe("sou");
    view.destroy();
  });
});

describe("provider-owned abbreviations", () => {
  const providerOptions = {
    providerOwnedAbbreviations: (language: string) => (
      language === "java" ? new Set(["sout", "soutm"]) : undefined
    ),
  };

  it("filters provider-owned plain templates from the completion source", () => {
    const source = createLiveTemplateCompletionSource(() => "App.java", providerOptions);
    const state = EditorState.create({ doc: "sout" });
    const result = source(new CompletionContext(state, 4, false));
    expect(result).not.toBeNull();
    if (!result || "then" in result) throw new Error("expected sync result");
    const labels = result.options.map((o) => o.label);
    expect(labels).not.toContain("sout");
    expect(labels).not.toContain("soutm");
    // The provider has no soutp/soutv, so the app keeps filling those gaps.
    expect(labels).toContain("soutp");
    expect(labels).toContain("soutv");
  });

  it("keeps non-Java languages untouched by the Java provider set", () => {
    const source = createLiveTemplateCompletionSource(() => "src/a.ts", providerOptions);
    const state = EditorState.create({ doc: "clg" });
    const result = source(new CompletionContext(state, 3, false));
    expect(result).not.toBeNull();
    if (!result || "then" in result) throw new Error("expected sync result");
    expect(result.options.some((o) => o.label === "clg")).toBe(true);
  });

  it("does not expand a provider-owned exact abbreviation with Tab", () => {
    const view = makeView("soutm");
    expect(expandLiveTemplateAt(view, "java", providerOptions)).toBe(false);
    expect(view.state.doc.toString()).toBe("soutm");
    expect(providerOwnedExactAbbreviationAt(view, "java", providerOptions)).toBe(true);
    view.destroy();
  });

  it("still expands app-owned abbreviations and postfix forms", () => {
    const plain = makeView("soutp");
    expect(expandLiveTemplateAt(plain, "java", providerOptions)).toBe(true);
    expect(plain.state.doc.toString()).toBe("System.out.println();");
    expect(providerOwnedExactAbbreviationAt(plain, "java", providerOptions)).toBe(false);
    plain.destroy();

    const postfix = makeView("list.sout");
    expect(expandLiveTemplateAt(postfix, "java", providerOptions)).toBe(true);
    expect(postfix.state.doc.toString()).toBe("System.out.println(list);");
    postfix.destroy();
  });

  it("collects provider snippet labels and app plain abbreviations", () => {
    const labels = providerSnippetAbbreviations([
      { label: "soutm", type: "text" },
      { label: "println()", type: "method" },
      { label: "sysout", type: "text" },
    ]);
    expect([...labels].sort()).toEqual(["soutm", "sysout"]);
    const appAbbreviations = plainTemplateAbbreviations("java");
    expect(appAbbreviations.has("soutm")).toBe(true);
    expect(appAbbreviations.has("soutp")).toBe(true);
  });
});

describe("catalog coverage", () => {
  it("includes core IDEA Java abbreviations", () => {
    const javaAbbr = new Set(
      LIVE_TEMPLATES
        .filter((t) => t.languages.includes("java") && !t.postfix)
        .map((t) => t.abbreviation),
    );
    for (const abbr of [
      "sout", "soutm", "soutv", "serr", "psvm", "main", "fori", "iter",
      "ifn", "inn", "psfs", "psf", "prsf", "thr",
    ]) {
      expect(javaAbbr.has(abbr)).toBe(true);
    }
  });
});

describe("preferences", () => {
  it("hides disabled built-ins and honors custom templates", () => {
    saveLiveTemplatePreferences({
      enabled: true,
      postfixEnabled: true,
      disabledBuiltinKeys: ["java|l|sout"],
      customTemplates: [{
        id: "c1",
        abbreviation: "mysout",
        body: "System.out.println(\"custom\");",
        description: "custom",
        languages: ["java"],
        postfix: false,
        enabled: true,
      }],
    });
    refreshLiveTemplatePreferencesCache();

    const listed = listLiveTemplateCompletions(docAt("sout").state.doc, 4, "java");
    const abbrs = listed?.matches.map((m) => m.template.abbreviation) ?? [];
    // Exact built-in `sout` is off; longer siblings (soutm/…) may still prefix-match.
    expect(abbrs).not.toContain("sout");
    expect(abbrs).toEqual(expect.arrayContaining(["soutm", "soutv"]));

    const custom = matchLiveTemplateAbbreviation(docAt("mysout").state.doc, 6, "java");
    expect(custom?.template.abbreviation).toBe("mysout");
    expect(custom?.exact).toBe(true);

    // Tab expand on exact "sout" must not resurrect the disabled template.
    const parent = document.createElement("div");
    document.body.appendChild(parent);
    const view = new EditorView({
      state: EditorState.create({ doc: "sout", selection: { anchor: 4 } }),
      parent,
    });
    expect(expandLiveTemplateAt(view, "java")).toBe(false);
    expect(view.state.doc.toString()).toBe("sout");
    view.destroy();
  });

  it("disables all templates when master switch is off", () => {
    saveLiveTemplatePreferences({
      ...DEFAULT_LIVE_TEMPLATE_PREFERENCES,
      enabled: false,
      customTemplates: [],
    });
    refreshLiveTemplatePreferencesCache();
    expect(matchLiveTemplateAbbreviation(docAt("sout").state.doc, 4, "java")).toBeNull();
    expect(expandLiveTemplateAt(
      new EditorView({ state: EditorState.create({ doc: "sout", selection: { anchor: 4 } }) }),
      "java",
    )).toBe(false);
  });
});
