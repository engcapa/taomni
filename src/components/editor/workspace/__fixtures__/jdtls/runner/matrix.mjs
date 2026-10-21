

// ---------------------------------------------------------------------------
// Fixture matrix (§8.19.4 scenario coverage)
// ---------------------------------------------------------------------------

export const APP_MAIN = "src/main/java/com/example/single/App.java";

export const APP_TEST = "src/test/java/com/example/single/AppTest.java";


// §8.20.2 W1 anchors inside signatureTargets() (see projects/maven-single).
export const SIG_OVERLOAD_LINE = 'sb.append("alpha");';

export const SIG_THREE_ARG_LINE = 'sb.append("ab", 0, 1);';

export const SIG_NESTED_LINE = 'String nested = String.valueOf(Integer.parseInt("42"));';

export const SIG_GENERIC_LINE = "java.util.Collections.singletonList(\"x\");";

export const SIG_PROJECT_SYMBOL_LINE = "new App().signatureTargets();";

export const SIG_LIBRARY_SYMBOL_LINE = 'org.apache.commons.lang3.StringUtils.isBlank("x");';


/**
 * Every case locates one bare token in one file, requests completion at the
 * token end, applies expectations, optionally resolves the matched item, and
 * optionally verifies that reverting the merged acceptance restores the
 * original document hash exactly. Cases with `kind` run the §8.20.2 W1
 * reference-information scenarios instead (signatureHelp / hover /
 * supersede-cancel against real jdtls).
 */
export const FIXTURES = {
  "maven-single": {
    buildTool: "maven",
    filesToOpen: [
      { path: APP_MAIN, tokens: ["Stri", "Arrays.", "appen", "StringUti"] },
      { path: APP_TEST, tokens: ["Asser"] },
    ],
    cases: [
      { id: "jdk-type", file: APP_MAIN, token: "Stri", expect: { labelEquals: "String", detailContains: "java.lang" } },
      { id: "static-member", file: APP_MAIN, token: "Arrays.", trigger: ".", expect: { labelEquals: "asList" } },
      { id: "generic-overload", file: APP_MAIN, token: "appen", expect: { labelStartsWith: "appen" }, recordOverloadsOf: "appen" },
      {
        id: "dependency-source-import",
        file: APP_MAIN,
        token: "StringUti",
        expect: { labelEquals: "StringUtils", detailContains: "org.apache.commons.lang3" },
        // jdtls also offers com.sun.tools.javac.util.StringUtils (JDK compiler
        // internals) as a same-name twin; recorded via matchedDetail.
        resolveExpect: { additionalEditCountMin: 1, additionalEditTextIncludes: "import org.apache.commons.lang3.StringUtils;" },
        verifyRevert: true,
      },
      {
        id: "test-source-set",
        file: APP_TEST,
        token: "Asser",
        expect: { anyLabelIn: ["Assert", "assertTrue", "assertFalse"] },
        notes: "candidate must come from junit test scope (proves test source set import)",
      },

      // ---- §8.20.2 W1: Parameter Info over a real overloaded family. ----
      {
        kind: "signature",
        id: "sig-overload-family",
        file: APP_MAIN,
        lineText: SIG_OVERLOAD_LINE,
        prefix: "sb.append(",
        expectSignature: { minSignatures: 2, labelContains: "append" },
        notes: "StringBuilder.append overload family; caret right after the open paren → activeParameter 0",
      },
      {
        kind: "signature",
        id: "sig-active-parameter-advance",
        file: APP_MAIN,
        lineText: SIG_THREE_ARG_LINE,
        prefix: "sb.append(\"ab\",",
        expectSignature: { minSignatures: 1, activeParameterEquals: 1 },
        notes: "caret between args of the 3-arg CharSequence,int,int overload → activeParameter advances to 1",
      },
      {
        kind: "signature",
        id: "sig-nested-inner",
        file: APP_MAIN,
        lineText: SIG_NESTED_LINE,
        prefix: "Integer.parseInt(",
        expectSignature: { minSignatures: 1, labelContains: "parseInt" },
        notes: "inner call of a nested expression owns the tooltip at its own paren",
      },
      {
        kind: "signature",
        id: "sig-nested-outer",
        file: APP_MAIN,
        lineText: SIG_NESTED_LINE,
        prefix: "String.valueOf(",
        expectSignature: { minSignatures: 1, labelContains: "valueOf" },
        notes: "outer call resolves when the caret sits at the outer argument list",
      },
      {
        kind: "signature",
        id: "sig-generic",
        file: APP_MAIN,
        lineText: SIG_GENERIC_LINE,
        prefix: "java.util.Collections.singletonList(",
        expectSignature: { minSignatures: 1, labelContains: "singletonList" },
        notes: "generic method signature; labels recorded for IDEA compare",
      },
      {
        kind: "supersede-cancel",
        id: "sig-supersede-cancel",
        file: APP_MAIN,
        lineText: SIG_OVERLOAD_LINE,
        prefix: "sb.append(",
        notes: "$/cancelRequest on the in-flight request mirrors the production cancel bridge; second request must satisfy",
      },

      // ---- §8.20.2 W1: Quick Documentation at project/JDK/library symbols.
      {
        kind: "hover",
        id: "hover-project-symbol",
        file: APP_MAIN,
        lineText: SIG_PROJECT_SYMBOL_LINE,
        token: "signatureTargets",
        expectHover: { contentsPresent: true },
        notes: "project symbol carries javadoc; provider must surface it through hover",
      },
      {
        kind: "hover",
        id: "hover-jdk-symbol",
        file: APP_MAIN,
        lineText: SIG_NESTED_LINE,
        token: "valueOf",
        expectHover: { contentsPresent: true },
        notes: "JDK class documentation attached to String.valueOf",
      },
      {
        kind: "hover",
        id: "hover-library-symbol",
        file: APP_MAIN,
        lineText: SIG_LIBRARY_SYMBOL_LINE,
        token: "isBlank",
        expectHover: { contentsPresent: true },
        notes: "commons-lang3 dependency symbol — synthesized from .class metadata when sources are absent",
      },
    ],
    restartAfterCases: { file: APP_MAIN, token: "Stri", expect: { labelEquals: "String" } },
    // §8.20.3 W2: a build-file change must bump the provider's analysis
    // generation (fresh import progress), and reverting must restore the model.
    buildChangeScenario: { file: "pom.xml" },
    // §8.20.4 W3 DoD: unresolved-type + import quick fix with post-image hash
    // and exact undo, against the real provider.
    quickFixScenario: {
      id: "import-quick-fix",
      file: "src/main/java/com/example/single/QuickFixTarget.java",
      symbol: "StringUtils",
      expectedDetailContains: "org.apache.commons.lang3",
    },
  },

  "maven-multi-module": {
    buildTool: "maven",
    filesToOpen: [{ path: "app/src/main/java/com/example/app/Main.java", tokens: ["CoreU", "Resu"] }],
    cases: [
      {
        id: "cross-module-type",
        file: "app/src/main/java/com/example/app/Main.java",
        token: "CoreU",
        expect: { labelEquals: "CoreUtil", detailContains: "com.example.core.CoreUtil" },
        resolveExpect: { additionalEditCountMin: 1, additionalEditTextIncludes: "import com.example.core.CoreUtil;" },
        verifyRevert: true,
      },
      {
        id: "ambiguous-same-name-types",
        file: "app/src/main/java/com/example/app/Main.java",
        token: "Resu",
        expect: { distinctDetailCountForLabelMin: ["Result", 2] },
        notes: "IDEA shows both twins with their FQNs; user picks one, resolve imports exactly that one",
      },
    ],
  },

  "gradle-single": {
    buildTool: "gradle",
    filesToOpen: [{ path: "src/main/java/org/example/gsingle/GApp.java", tokens: ["Stri"] }],
    cases: [
      { id: "gradle-import-sanity", file: "src/main/java/org/example/gsingle/GApp.java", token: "Stri", expect: { labelEquals: "String", detailContains: "java.lang" } },
    ],
  },

  "gradle-multi-module": {
    buildTool: "gradle",
    filesToOpen: [{ path: "app/src/main/java/org/example/gapp/GMain.java", tokens: ["GCo"] }],
    cases: [
      {
        id: "cross-module-type",
        file: "app/src/main/java/org/example/gapp/GMain.java",
        token: "GCo",
        expect: { labelEquals: "GCore" },
        resolveExpect: { additionalEditCountMin: 1, additionalEditTextIncludes: "import org.example.gcore.GCore;" },
        verifyRevert: true,
      },
    ],
  },

  "maven-broken-classpath": {
    buildTool: "maven",
    filesToOpen: [{ path: "src/main/java/com/example/broken/Broken.java", tokens: ["MissingUti", "Stri"] }],
    collectDiagnostics: true,
    cases: [
      {
        id: "missing-dependency-candidate-absent",
        file: "src/main/java/com/example/broken/Broken.java",
        token: "MissingUti",
        expect: { labelAbsent: "MissingUtil" },
        notes: "broken classpath must not fabricate the dependency type",
      },
      {
        id: "jdk-still-completes-on-broken-classpath",
        file: "src/main/java/com/example/broken/Broken.java",
        token: "Stri",
        expect: { labelEquals: "String", detailContains: "java.lang" },
        notes: "java.lang completion survives the unresolvable dependency",
      },
    ],
  },
};
