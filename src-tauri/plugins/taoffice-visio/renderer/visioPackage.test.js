import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { unzipSync, zipSync } from "fflate";
import { expect, it } from "vitest";
import { editableVisio, fieldKey, saveVisioCopy } from "./visioPackage.js";

const bytes = new Uint8Array(readFileSync(resolve("qa-ui-auto-tests/fixtures/taoffice/visio-routing.vsdx")));
const pages = [{ name: "Routing overview" }, { name: "Delivery details" }];
const drawing = editableVisio(bytes, pages);
const page = drawing.pages[1];
const shape = page.shapes[0];

function modify(path, transform) {
  const parts = unzipSync(bytes);
  parts[path] = new TextEncoder().encode(transform(new TextDecoder().decode(parts[path])));
  return editableVisio(zipSync(parts), pages);
}

it("maps decoded page order to explicit OPC relationships", () => {
  expect(page.path).toBe("visio/pages/page2.xml");
  expect(shape.fields).toMatchObject({ Text: "Routing approval", PinX: "2", FillForegnd: "#dfeddb" });
  expect(editableVisio(bytes, pages.toReversed())).toBeNull();
});

it("returns the original package for an unchanged copy", () => {
  expect(saveVisioCopy(drawing, new Map())).toBe(bytes);
});

it("reopens text, position and color edits with every other package part byte-identical", () => {
  const desired = { Text: "Confirmed <&> 审批 🚀", PinX: "3.25", PinY: "-1", LineColor: "#020304", FillForegnd: "#112233" };
  const edits = new Map(Object.entries(desired).map(([name, value]) => [fieldKey(page, shape, name), value]));
  const output = saveVisioCopy(drawing, edits);
  expect(editableVisio(output, pages).pages[1].shapes[0].fields).toMatchObject(desired);
  const original = unzipSync(bytes);
  const copy = unzipSync(output);
  expect(Object.keys(copy).sort()).toEqual(Object.keys(original).sort());
  expect(Object.keys(original).filter(path => Buffer.compare(copy[path], original[path]) !== 0)).toEqual([page.path]);
  expect(editableVisio(bytes, pages).pages[1].shapes[0].fields.Text).toBe("Routing approval");
});

it.each([["Text", "\u0001"], ["Text", "x".repeat(2049)], ["FillForegnd", "inherit"], ["PinY", "Infinity"], ["PinX", ""], ["PinX", "100001"]])(
  "rejects invalid %s edits before creating a package", (name, value) => {
    expect(() => saveVisioCopy(drawing, new Map([[fieldKey(page, shape, name), value]]))).toThrow();
  },
);

it("rejects stale fields and preserves rich text, formulas, and locked or connected shapes", () => {
  const restricted = modify(page.path, xml => xml
    .replace("<Text>Routing approval</Text>", '<Text><cp IX="0"/>Routing approval</Text>')
    .replace('<Cell N="PinX" V="2"/>', '<Cell N="PinX" V="2" F="Width*0.5"/>')
    .replace('<Shape ID="2" Type="Shape">', '<Shape ID="2" Type="Shape"><Cell N="LockMoveX" V="1"/>')
    .replace('</PageContents>', '<Connects><Connect FromSheet="3" ToSheet="2"/></Connects></PageContents>'));
  expect(restricted.pages[1].shapes.map(item => item.id)).toEqual(["1"]);
  expect(restricted.pages[1].shapes[0].fields).not.toHaveProperty("Text");
  expect(restricted.pages[1].shapes[0].fields).not.toHaveProperty("PinX");
  expect(() => saveVisioCopy(restricted, new Map([[fieldKey(page, shape, "Text"), "changed"]]))).toThrow();
});

it.each([
  ["visio/document.xml", s => s.replace("/>", "><DocumentSettings><ProtectShapes>1</ProtectShapes></DocumentSettings></VisioDocument>")],
  ["visio/document.xml", s => s.replace("/>", '><DocumentSettings ProtectShapes="1"/></VisioDocument>')],
  ["[Content_Types].xml", s => s.replace("</Types>", '<Override ContentType="application/vnd.openxmlformats-package.digital-signature-xmlsignature+xml"/></Types>')],
  ["visio/pages/_rels/pages.xml.rels", s => s.replace("page2.xml", "page1.xml")],
  ["visio/pages/_rels/pages.xml.rels", s => s.replace('Target="page2.xml"', 'TargetMode="External" Target="page2.xml"')],
  ["visio/pages/page2.xml", s => s.replace('ID="2"', 'ID="1"')],
  ["visio/pages/page1.xml", s => '<!DOCTYPE PageContents>' + s],
])("leaves unsupported packages view-only (%s)", (path, transform) => {
  expect(modify(path, transform)).toBeNull();
});

