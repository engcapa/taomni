import { PermissionFlag } from "pdfjs-dist/legacy/build/pdf.mjs";

export const MAX_EXPORTED_BYTES = 32 * 1024 * 1024;
const SUPPORTED = new Set(["text", "checkbox", "combobox", "listbox"]);

export async function loadForm(pdf) {
  const [fieldObjects, permissions] = await Promise.all([pdf.getFieldObjects(), pdf.getPermissions()]);
  const all = fieldObjects instanceof Map ? [...fieldObjects.values()].flat() : [];
  const names = new Set();
  const fields = all.filter((field) => {
    // A PDF field can have several widgets, all sharing its stored value.
    // Widgets without a display page are outside the document's form.
    const supported = SUPPORTED.has(field.type) && !field.hidden && field.page >= 0 && !field.password
      && !field.multipleSelection && field.name && !names.has(field.name);
    if (supported) names.add(field.name);
    return supported;
  }).map((field) => ({ ...field, widgets: all.filter((item) => item.name === field.name && item.type === field.type) }));
  return {
    fields,
    editable: (!permissions || permissions.has(PermissionFlag.FILL_INTERACTIVE_FORMS))
      && !all.some((field) => field.type === "signature"),
  };
}

export function originalValue(field) {
  if (field.type === "checkbox") return field.value === field.exportValues;
  return typeof field.value === "string" ? field.value : "";
}

export function applyFormValue(storage, field, value) {
  for (const widget of field.widgets) {
    const original = originalValue(widget);
    if (value === original) storage.remove(widget.id);
    else storage.setValue(widget.id, { value });
  }
}
