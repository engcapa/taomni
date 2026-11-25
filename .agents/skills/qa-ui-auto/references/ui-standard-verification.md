# Desktop UI verification

Use the [control matrix](../../../../docs-feature/ui-standard/UI-STANDARD.md) and
[verification recipes and sample case](../../../../docs-feature/ui-standard/ENFORCEMENT.md)
to select applicable states for the actual page and owning window.

Declare the union of the requirement rule IDs in top-level `ui_standard`.
For each requirement, identify the action and the observed result. A focus
assertion reads the active element after the action. A destructive cancel also
checks the original object. A theme check measures rendered foreground against
the painted background in each state. Record OS input and WebView dispatch
separately. Use `ui-contract` for cross-feature contract cases and run them
with affected workflows and `crash-regression`.
