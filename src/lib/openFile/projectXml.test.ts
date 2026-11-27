import { describe, expect, it } from "vitest";
import { hasProjectRoot } from "./projectXml";

describe("detecting a Microsoft Project XML prefix", () => {
  it("uses the root namespace and allows declarations, comments and prefixes", () => {
    expect(hasProjectRoot('<?xml version="1.0"?>\n<!-- schedule -->\n<m:Project xmlns:m="http://schemas.microsoft.com/project"><m:Tasks>')).toBe(true);
    expect(hasProjectRoot('<Project xmlns="http://schemas.microsoft.com/project"/>')).toBe(true);
  });

  it("keeps ordinary XML and nested project elements in the text viewer", () => {
    expect(hasProjectRoot('<Project xmlns="urn:example:layout">')).toBe(false);
    expect(hasProjectRoot('<Document><Project xmlns="http://schemas.microsoft.com/project">')).toBe(false);
    expect(hasProjectRoot('<Project xmlns="http://schemas.microsoft.com/project"')).toBe(false);
  });
});
