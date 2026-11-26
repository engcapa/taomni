# ADR 2026-11-15: Taomni 综合文件查看与编辑 — taoffice（核心 + 7 个独立插件）

## Status

Accepted as a design decision; implementation not started. v1.3 is the current revision, based on main `ee9f8062d` (Merge PR #814) and a five-track mature-library comparison survey of 2026-11-15. Implementation waits for the modular M0 plugin runtime (see modular-split design v1.4, G1–G10); only the §11 spikes (now S1–S13) and the core viewer dispatch extension point may start before M0. The full design is in `docs-feature/taoffice-design.md` v1.3. v1.3 changes the preferred engine route from storytold craft-xxx to a hybrid mature stack (design §8.12); craft is demoted to fallback/observe.

## 1. Context

Taomni's main branch now has a general file viewer (PR #813/#814): `classifyFile` sorts files into 8 kinds, but only 5 are supported in-app (image, svg, text, markdown, html); PDF is classified but falls back to the system app; Office, Visio, MS Project, video and archives have no viewer at all. The viewer, `documentStore` and the Rust `viewer_*` commands all live in core, and there is no extension point for a plugin to register a new file type.

The user asked for comprehensive viewing and editing of common file types under the internal module name taoffice, built as independently compilable, releasable and installable modules, on top of the `refactor/modules-arch` modularisation work. Confirmed 2026-11-15: core carries md/txt/html/code/images/archives; every other family is one plugin each, downloaded on demand; single-package cap is 100 MB; remote files stay read-only temp copies; third-party capability comes from Rust/TS libraries compiled into the app, never a sidecar process.

## 2. Decision

### 2.1 Core vs plugins

- Core (default install): md, txt, html, code files (existing CodeWorkspace routing), image viewing, archive view + extract (zip/7z/tar/gz/bz2/xz/zst/rar-extract-only), plus a viewer dispatch extension point so plugins can register new types without changing core per type.
- Seven taoffice plugins, each `taomni-plugin-taoffice-<slug>`, independent SemVer and release: pdf (P1), excel (P1), video incl. audio (P1 playback / P3 edit), word (P2), project (P2), ppt (P3), visio (P3).
- Priority order is core → common → rare, weighted by complexity; archives outrank video transcoding; viewing outranks editing within a family.

### 2.2 Plugin shape (reuses modular-split v1.4, no new invention)

Plugin = frontend chunk (dynamic `import()`, shared React via host) + optional native host executable, stdio JSON-RPC 2.0, `module.json` (with taoffice additions `fileKinds`/`extensions`), `kind: "document"` (new kind value), `coreApiVersion: 1`, `.taomni-plugin` package + detached signature, `modules.json` entry. Downloads follow the repo `AGENTS.md` rules (three proxy modes, progress, cancel, resume, checksum).

### 2.3 What "true editing" and "renders like Visio" mean under the no-sidecar rule

- Office editing is surgical patching of the original OPC package (only changed XML parts replaced), not a pixel-faithful Word clone: Excel is genuinely editable, Word is a block editor (pagination/text boxes/SmartArt/charts/track-changes will drop), PowerPoint is text replacement only.
- **v1.3: the preferred engine route is a hybrid mature stack, not storytold craft-xxx** (design §8.12, five-track comparison 2026-11-15; all five tracks independently ruled craft should not stay first choice). DOCX: Office Oxide (`EditableDocument` promises surgical patch) + BetterOffice spike first (yrs CRDT + React 19 components, pure Rust, no winit conflict). XLSX: calamine read + IronCalc calc + self-built zip+quick-xml surgical-patch save (rxls as对照 spike). PPTX: office_oxide format layer + PptxViewJS render + PptxGenJS new files, OpenPresent as #1 watch object. PDF: pdfium-render 0.9.5 render (~8 MB/platform dynamic lib) + lopdf 0.46.0 + @cantoo/pdf-lib 2.11.1 edit (+ krilla for PDF/A creation); craft-pdf is a thin wrapper over hayro + krilla, so depend on those directly if pure Rust is required. Video: Tier 1 native `<video>`, Tier 2 WebCodecs + Mediabunny, **Tier 3 ffmpeg-next LGPL static decode build** (FilmCraft demoted to S7 parallel candidate); audio symphonia + cpal/rodio. Images/archives (core): image-rs ecosystem + resvg, `zip` 9.5.1 + `sevenz-rust2` + RAR via rars spike. Visio: libvisio (MPL-2.0) → WASM best-effort render + explicit notice — no open-source library reaches Visio-level fidelity. MS Project: mpxj-rs read + MSPDI XML write; .mpp write-back (template method, MIT, alpha, MPP14-only) is P3 watch only. Storytold craft-libs / Craft apps are demoted to fallback/observe (design §8.10/§8.11 kept as reference; UI was never reused — all Craft apps render with egui, no React/WebView binding). Reuse is gated by spikes S1–S13, with S10 (decoded frames into WebView, highest priority) and S11 (BetterOffice + Office Oxide) new in v1.3.
- Visio rendering goes through `libvisio-rs` (Rust, GPL-3.0) or `libvisio` C++ (MPL-2.0) behind a fidelity + licence spike; editing is XML-level simple items only. No Visio equivalent exists in the storytold org.
- MS Project cannot save back to `.mpp` on any open-source path; editing saves as `.xml`/`.mppx` (MSPDI). No MS Project equivalent exists in the storytold org.
- Video playback is tiered: native `<video>`, then WebCodecs + Mediabunny for MKV, then **ffmpeg-next LGPL static decode build** (Tier 3 first choice since v1.3) for AVI/FLV/WMV/RM; FilmCraft is a parallel S7 candidate for the mainstream-container part; RM/RMVB is transcode-on-demand, lowest priority. New top-priority spike S10: decoded-frames-into-WebView transport is unverified for every Rust-side route.

## 3. Consequences

- Good: core stays free of office/video engines; each plugin is independently shippable and rollback-able within 100 MB; no external processes to manage and no cloud conversion. The storytold `craft-libs` layer gives taoffice a real format layer (with passthrough preservation) instead of assembling one format library at a time.
- Costs: full-fidelity Office/Visio editing is not achievable with libraries alone, and the design says so in writing on each plugin page; Visio and FFmpeg carry licence reviews (GPL-3.0 / LGPL) that must pass before building; Project and PowerPoint editing are explicitly scoped down. The hybrid stack replaces storytold's git-rev supply-chain risk with per-library verification risk: Office Oxide and BetterOffice are young (2026), rxls and rars are very early, and the frames-into-WebView transport is unverified for every Rust-side video route — all verified in spikes S10–S13 before depending on them.
- Blocked on: M0 plugin runtime (G1–G10); thirteen spikes S1–S13 (Visio fidelity via libvisio WASM, mpxj-rs completeness, Excel route, ffmpeg-next minimal build size, WebCodecs on Linux WebKitGTK, surgical-patch verification for Office Oxide/BetterOffice, FilmCraft as parallel candidate, craft-libs licences/toolchain/Tauri coexistence, pdfcraft/gridcraft/deckcraft reuse as observe-only, frames-into-WebView, BetterOffice + Office Oxide, pdfium distribution + RAR + zip upgrade, craft-libs unreviewed-crate对照).

## 4. Open interpretations (need the user's nod, design §14.1)

- (a) The tiered reading of Office "true editing" above.
- (b) Project edits save as `.xml`/`.mppx`, never back to `.mpp`.
- (c) RM/RMVB is transcode-on-demand, lowest video priority.
- (d) Whether the surgical patch holds in practice (spikes S6/S11): Office Oxide's `EditableDocument` and BetterOffice's save must leave untouched OPC parts byte-identical; if not, Word/Excel/PPT save as full re-serialise + regression corpus.
- (e) Video Tier 3 first choice is now ffmpeg-next LGPL static decode build (spike S4), with FilmCraft as a parallel S7 candidate; if S4 fails on LGPL compliance or size, Tier 3 falls back to Tier 1–2 playback + system app.
- (f) **The preferred route changes as a whole from craft-xxx to the hybrid mature stack (design §8.12)**, with craft demoted to fallback/observe — needs the user's nod (design §14.1 (f)).
