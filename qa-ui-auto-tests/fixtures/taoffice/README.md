# TaOffice fixtures

WinRAR 6.11 created `records.RAR` with `-ma5 -m5 -s` and `legacy.rar` with `-ma4 -m5 -s`. Each archive contains `notes/first.txt` and `notes/second.txt` in a solid block. Each text file contains 32 copies of the UTF-8 string `File open original\nSecond line\n中文\n`, where `\n` represents LF. `locked.rar` uses the RAR5 options with header encryption and fixture password `taoffice-fixture`.

`quarterly.xlsx` includes the `QuarterlyTotals` spreadsheet table over `Totals!A1:C3`. Row 1 matches the table column metadata. Rows 2 and 3 hold text and numeric data plus formulas with cached results. The browser fixture mirrors the edit restrictions. The native case saves and reopens a copy and checks the original header.
