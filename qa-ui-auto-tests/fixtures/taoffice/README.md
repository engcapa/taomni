# TaOffice fixtures

WinRAR 6.11 created `records.RAR` with `-ma5 -m5 -s` and `legacy.rar` with `-ma4 -m5 -s`. Each archive contains `notes/first.txt` and `notes/second.txt` in a solid block. Each text file contains 32 copies of the UTF-8 string `File open original\nSecond line\n中文\n`, where `\n` represents LF. `locked.rar` uses the RAR5 options with header encryption and fixture password `taoffice-fixture`.

`quarterly.xlsx` includes the `QuarterlyTotals` spreadsheet table over `Totals!A1:C3`. Row 1 matches the table column metadata. Rows 2 and 3 hold text and numeric data plus formulas with cached results. The browser fixture mirrors the edit restrictions. The native case saves and reopens a copy and checks the original header.

- `planning-notes.docx` is a two-page Word fixture with a header, footer, an italic paragraph with a bold run, and a table. The cases edit the mixed-format paragraph and a table cell, then verify the styled run and surrounding document.
- LibreOffice Writer 24.2.7.2 exported `legacy-notes.doc`, `legacy-notes.odt` and `legacy-notes.rtf` from `planning-notes.docx`. Each fixture has the same body, table and second-page text. The DOC export uses the Microsoft Word 97 filter.
- `rollout.mppx` is an MSPDI fixture with a summary task, a milestone, a predecessor and one resource assignment. Native coverage opens these bytes as `rollout.xml`.
- `shift-plan.mppx` includes a calendar exception on December 2, a finish-to-start dependency and an independent task with a baseline. Native coverage opens and saves the schedule as MSPDI XML.
- `linked-tasks.mpp` is the MPXJ Project 2000 task-links fixture at commit `63cdc4e8dd9eaa4c7b87158dcbd5fda77a04b671`, blob `4111f5350671a0adaf7330e1ccc728321bc1a10f`. It exercises eight predecessor links in a binary MPP9 file. The Browser fixture authenticates these bytes by SHA-256 and returns the two-task `linked-tasks-preview.xml` model. Native opens the binary file using the installed Project host. [Upstream fixture](https://github.com/joniles/mpxj/blob/63cdc4e8dd9eaa4c7b87158dcbd5fda77a04b671/junit/data/generated/task-links/task-links-project2000-mpp9.mpp)
- `linked-tasks.mpx` and `exchange-de.mpx` contain original MPXJ test data at the same revision. The first is the Project 98 task-links export. The second uses German field definitions and signed predecessor lag. Browser cases use a two-task projection of the latter file from `exchange-preview.xml`. Native tests import the source bytes. [Project 98 task links](https://github.com/joniles/mpxj/blob/63cdc4e8dd9eaa4c7b87158dcbd5fda77a04b671/junit/data/generated/task-links/task-links-project98.mpx) · [German MPX](https://github.com/joniles/mpxj/blob/63cdc4e8dd9eaa4c7b87158dcbd5fda77a04b671/junit/data/sample.de.mpx)
- `rollout-replay.webm` contains 12 seconds of VP8 test footage at 160 × 90. FFmpeg encoded the source as MPEG-4 v2 in AVI and converted it to WebM for playback checks.
- `rollout-compatible.mkv` wraps the same VP8 frames in Matroska and adds a synthetic 440 Hz Opus track. It exercises audio and video retention in compatible playback.

`forecast.xlsx` extends the quarterly workbook with a cross-sheet SUM and a dependent text-valued IF in Inventory. Changing Totals!B2 from 12 to 15.5 changes Totals!C2 to 31, Inventory!D2 to 47 and Inventory!E2 to Review.

`shift-work.mppx` adds named resources and two assignments to the holiday-aware shift plan. It exercises new tasks, dependency recalculation and resource assignment round trips.

`ppt-review.pptx` contains two slides with mixed text runs, table cells, notes and chart content. Regenerate it with `node qa-ui-auto-tests/fixtures/taoffice/ppt-build-review.mjs`. The edit checks compare the saved slide and the original OPC parts.

`media-edit.webm` and `media-legacy.*` use synthetic test patterns and tones. The browser case trims the VP8/Opus WebM fixture. The native cases open AVI, FLV, WMV and RealMedia, and save a resized H.264/AAC copy of the AVI.

Microsoft PowerPoint on Windows exported legacy-review.ppt (PowerPoint 97–2003) and legacy-review.odp from ppt-review.pptx. Both have two slides with the quarterly review and delivery appendix.

Visio fixture inputs and provenance are documented in [visio-sources.md](visio-sources.md).
