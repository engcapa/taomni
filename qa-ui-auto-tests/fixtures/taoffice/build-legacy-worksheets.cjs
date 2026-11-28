// Run with a local SheetJS 0.18.5 xlsx.full.min.js to regenerate these synthetic workbooks.
const path = require("node:path");
const fs = require("node:fs");
const os = require("node:os");
const { execFileSync } = require("node:child_process");
const { pathToFileURL } = require("node:url");

const xlsx = require(path.resolve(process.argv[2]));
const workbook = xlsx.utils.book_new();
const orders = xlsx.utils.aoa_to_sheet([
  ["Item", "Units", "Amount"],
  ["Pencils", 7, 21],
  ["Notebook", 5, 15],
]);
orders.C2.f = "B2*3";
orders.M35 = { t: "s", v: "Far corner" };
orders["!ref"] = "A1:M35";
const stock = xlsx.utils.aoa_to_sheet([["Warehouse", "In stock"], ["上海", true]]);
const internal = xlsx.utils.aoa_to_sheet([["Internal sheet"]]);
xlsx.utils.book_append_sheet(workbook, orders, "Orders");
xlsx.utils.book_append_sheet(workbook, stock, "Stock");
xlsx.utils.book_append_sheet(workbook, internal, "Internal");
xlsx.utils.book_set_sheet_visibility(workbook, "Internal", xlsx.utils.consts.SHEET_HIDDEN);

fs.writeFileSync(path.join(__dirname, "legacy-orders.xlsb"), xlsx.write(workbook, {
  bookType: "xlsb", bookSST: true, type: "buffer",
}));

const work = fs.mkdtempSync(path.join(os.tmpdir(), "taoffice-legacy-sheets-"));
try {
  const source = path.join(work, "legacy-orders.xlsx");
  const profile = pathToFileURL(path.join(work, "office")).href;
  fs.writeFileSync(source, xlsx.write(workbook, { bookType: "xlsx", type: "buffer" }));
  for (const format of ["xls:MS Excel 97", "ods:calc8"]) {
    execFileSync("soffice", [
      "-env:UserInstallation=" + profile, "--headless", "--convert-to", format, "--outdir", __dirname, source,
    ], { stdio: "inherit" });
  }
} finally {
  fs.rmSync(work, { recursive: true, force: true });
}
