import { EditorView, ViewPlugin, type ViewUpdate } from "@codemirror/view";
import { isEditorGeometryReady } from "../virtualSpace/geometry";

/** Action/menu projection runs during React render. Read viewport dimensions
 * only in CodeMirror's shared measurement phase, after its pending DOM writes. */
export const editorActionGeometry = ViewPlugin.fromClass(class {
  ready = false;
  private disposed = false;
  private readonly measurement;

  constructor(view: EditorView) {
    this.measurement = {
      read: () => !this.disposed && isEditorGeometryReady(view),
      write: (ready: boolean) => { if (!this.disposed) this.ready = ready; },
    };
    view.requestMeasure(this.measurement);
  }

  update(update: ViewUpdate) {
    if (update.geometryChanged || update.viewportChanged) {
      update.view.requestMeasure(this.measurement);
    }
  }

  destroy() {
    this.disposed = true;
    this.ready = false;
  }
});

export function measuredEditorActionGeometryReady(view: EditorView): boolean {
  return view.inView && (view.plugin(editorActionGeometry)?.ready ?? false);
}
