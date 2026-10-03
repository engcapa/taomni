import { describe, expect, it } from "vitest";
import { importFoldRange } from "./importFold";

describe("ED-PARITY-011 default import folding", () => {
  it("folds a Java import block from after the first `import ` to the last import", () => {
    const text = "package demo;\n\nimport java.util.List;\n// util\nimport java.util.Map;\n\npublic class A {}\n";
    const range = importFoldRange("src/A.java", text);
    expect(range).not.toBeNull();
    expect(text.slice(0, range!.from)).toBe("package demo;\n\nimport ");
    expect(text.slice(range!.from, range!.to)).toBe("java.util.List;\n// util\nimport java.util.Map;");
  });

  it("leaves single imports, non-code files and files without imports alone", () => {
    expect(importFoldRange("A.java", "import a.B;\nclass A {}\n")).toBeNull();
    expect(importFoldRange("notes.txt", "import a;\nimport b;\n")).toBeNull();
    expect(importFoldRange("A.java", "class A {}\n")).toBeNull();
  });

  it("stops at the first code line so later imports-like text is not folded", () => {
    const text = "import a from \"a\";\nimport b from \"b\";\nconst s = \"import c\";\nimport d from \"d\";\n";
    const range = importFoldRange("x.ts", text);
    expect(text.slice(range!.from, range!.to)).toBe("a from \"a\";\nimport b from \"b\";");
  });
});
