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

Use `assert_focus_on` for an exact active element, `assert_focus_within` for a compound control, and `assert_computed_style: {selector, property, equals}` for its resolved CSS value. Each waits for one matching element in the current browser or native window.

Register each private dialog route in `qa-ui-auto-tests/fixtures/ui-contract-registry.yaml`.
Include its setup, fixtures, title, first and last enabled control, and logical
focus return target. Run `python -m qa_ui_auto.ui_contract_gen` from the repository
root, register the generated ID in CI policy and execute both modes. The workflow
checks the generated files against the registry before planning. Business results,
such as creating the file on disk, belong in the corresponding feature case.
