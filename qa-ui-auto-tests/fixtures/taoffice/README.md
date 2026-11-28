# TaOffice fixtures

WinRAR 6.11 created `records.RAR` with `-ma5 -m5 -s` and `legacy.rar` with `-ma4 -m5 -s`. Each archive contains `notes/first.txt` and `notes/second.txt` in a solid block. Each text file contains 32 copies of the UTF-8 string `File open original\nSecond line\n中文\n`, where `\n` represents LF. `locked.rar` uses the RAR5 options with header encryption and fixture password `taoffice-fixture`.

`quarterly.xlsx` includes the `QuarterlyTotals` spreadsheet table over `Totals!A1:C3`. Row 1 matches the table column metadata. Rows 2 and 3 hold text and numeric data plus formulas with cached results. The browser fixture mirrors the edit restrictions. The native case saves and reopens a copy and checks the original header.

- `planning-notes.docx` is a two-page Word fixture with a header, footer, an italic paragraph with a bold run, and a table. The cases edit the mixed-format paragraph and a table cell, then verify the styled run and surrounding document.
- `rollout.mppx` is an MSPDI fixture with a summary task, a milestone, a predecessor and one resource assignment. Native coverage opens these bytes as `rollout.xml`.
- `shift-plan.mppx` includes a calendar exception on December 2, a finish-to-start dependency and an independent task with a baseline. Native coverage opens and saves the schedule as MSPDI XML.
- `linked-tasks.mpp` is the MPXJ Project 2000 task-links fixture at commit `63cdc4e8dd9eaa4c7b87158dcbd5fda77a04b671`, blob `4111f5350671a0adaf7330e1ccc728321bc1a10f`. It exercises eight predecessor links in a binary MPP9 file. The Browser fixture authenticates these bytes by SHA-256 and returns the two-task `linked-tasks-preview.xml` model. Native opens the binary file using the installed Project host. [Upstream fixture](https://github.com/joniles/mpxj/blob/63cdc4e8dd9eaa4c7b87158dcbd5fda77a04b671/junit/data/generated/task-links/task-links-project2000-mpp9.mpp)
- `rollout-replay.webm` contains 12 seconds of VP8 test footage at 160 × 90. FFmpeg encoded the source as MPEG-4 v2 in AVI and converted it to WebM for playback checks.
- `rollout-compatible.mkv` wraps the same VP8 frames in Matroska and adds a synthetic 440 Hz Opus track. It exercises audio and video retention in compatible playback.
