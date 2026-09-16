# IDEA Visual And Interaction Verification

This is optional for IDEA tasks. General app tests acquire no IDEA dependency.

Read the task ACs and `idea-reference` package. Match actual build, fixture,
settings, client size, theme, fonts/DPR and keymap. Reuse valid IDEA captures
across Taomni iterations; only sample missing states. Source/manuals explain
behavior but do not prove an observed GUI state.

Current UI is not the golden baseline for a redesign. Derive the target from
IDEA and explicit Taomni adaptations; record changed expectations and retained
data/transaction/undo contracts.

Use [regression protection](regression-protection.md) for those retained behaviors:
IDEA captures define the intended target; Taomni's relevant pre-change observations
establish behavior that must continue. Keep both in the acceptance set. Replacing
a menu or editor component cannot silently drop an existing action or break another
consumer. Expected visual changes may update the target without weakening result,
focus/recovery or data assertions that still apply.

| Axis | Required observations |
|---|---|
| Visual | Actual matching-state screenshots; geometry, density, typography, icons/colors, selected/disabled/unfocused states, popup anchor/edge/overflow |
| Interaction | Real mouse/keyboard sequence, focus destination, Enter/Tab/Esc, cancel, multiple entrances, drag/scroll and applicable IME/undo |
| Function | Text/file/result set, provider effects and history/recovery postconditions |

Choose the smallest representative states exposing the change. Shared tokens
need representative consumers; shared input needs affected modal/editor paths.
No unconditional theme×size×OS×provider matrix; record platform evidence separately.

Align client regions, retain complete originals and link crops. Mask only named
dynamic noise, never changed controls/text. Pixel diff is diagnostic because
font rasterization differs. Geometry tolerances derive from the target; document
differences rather than invent a universal similarity percentage. Screenshots
alone cannot prove interaction.

Use browser feedback while editing, then a compact current-WebView smoke and
native tests for affected OS behavior. One run can collect UI, provider and result
evidence. Do not compile per screenshot. Prototype captures are design inputs.

Formal records use the selected
`claudedocs/code-workspace-idea-specs/idea-comparison.schema.json` and
`.agents/skills/code-workspace-idea-task/scripts/compare_idea.py`. Current schema
is tied to 2026.2.x; other-version references remain version-scoped until a new
contract supports them. Do not silently relax historical validation.

Ordinary validator exit 0 includes valid incomparable/unverified records. A
match requirement needs `--require-match`, computed verdict/artifact review and
the actual visual/interaction assertions. JSON validation does not measure
visual fidelity; link visual comparison tables/artifacts to ACs separately.

Record functional, visual and interaction deltas independently. Accepted
deviations and historical waivers are explicit exceptions, not equality or new
waivers. Missing IDEA/native data keeps the corresponding layer unverified.
Never insert manual captures into runner summaries or issue prototype receipts.
