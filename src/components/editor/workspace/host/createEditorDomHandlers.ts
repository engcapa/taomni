import { EditorView } from "@codemirror/view";
import { writeText } from "../../../../lib/clipboard";
import { lspPositionFromOffset } from "../lspPositions";
import { cutEditorSelections, editorClipboardPayload, pasteEditorClipboardPayload } from "../workspaceEditorCommands";
import { rememberEditorClipboardPayload, cutSystemClipboard, payloadForSystemClipboardText, writeEditorSelectionToClipboard, pasteSystemClipboard } from "./clipboard";


export interface CreateEditorDomHandlersContext {
  pointerClickCountRef: import("react").RefObject<number>;
  shiftExtendKeyRef: import("react").RefObject<boolean>;
  onContextMenuRef: import("react").RefObject<((info: import("./types").EditorContextMenuRequest) => void) | undefined>;
}

export function createEditorDomHandlers(context: CreateEditorDomHandlersContext) {
  const { pointerClickCountRef, shiftExtendKeyRef, onContextMenuRef } = context;
  return EditorView.domEventHandlers({
    // WebKitGTK's WebDriver pointer path can deliver the editor mouse
    // event without transferring DOM focus from the body. Keep the
    // production pointer entry equivalent to a user click before
    // CodeMirror resolves its selection position.
    mousedown(_event, view) {
      pointerClickCountRef.current = _event.detail || 1;
      shiftExtendKeyRef.current = false;
      if (!view.hasFocus) view.focus();
      return false;
    },
    copy(event, view) {
      const payload = editorClipboardPayload(view.state);
      if (!payload) return false;
      event.preventDefault();
      if (event.clipboardData) {
        event.clipboardData.setData("text/plain", payload.plainText);
        rememberEditorClipboardPayload(view, payload);
      } else {
        void writeText(payload.plainText).then(() => {
          if (view.dom.isConnected) rememberEditorClipboardPayload(view, payload);
        }).catch(() => { });
      }
      return true;
    },
    cut(event, view) {
      if (view.composing || view.state.readOnly) return false;
      const payload = editorClipboardPayload(view.state);
      if (!payload) return false;
      event.preventDefault();
      if (!event.clipboardData) {
        cutSystemClipboard(view);
        return true;
      }
      event.clipboardData.setData("text/plain", payload.plainText);
      rememberEditorClipboardPayload(view, payload);
      return cutEditorSelections(view);
    },
    paste(event, view) {
      if (view.composing || view.state.readOnly) return false;
      const text = event.clipboardData?.getData("text/plain");
      if (text === undefined) return false;
      event.preventDefault();
      return pasteEditorClipboardPayload(view, payloadForSystemClipboardText(view, text));
    },
    contextmenu(event, view) {
      const handler = onContextMenuRef.current;
      if (!handler) return false;
      const coords = { x: event.clientX, y: event.clientY };
      // posAtCoords can be null in headless/jsdom; fall back to caret.
      const pos = view.posAtCoords(coords) ?? view.state.selection.main.head;
      event.preventDefault();
      const clickedSelection = view.state.selection.ranges.find((range) => (
        pos >= range.from && pos <= range.to
      ));
      // Click outside every selection: place the caret there (IDEA-like).
      if (!clickedSelection) {
        view.dispatch({ selection: { anchor: pos }, scrollIntoView: true });
      }
      const selection = view.state.selection.main;
      const selectedRanges = view.state.selection.ranges.filter((range) => !range.empty);
      const selectedText = selectedRanges
        .map((range) => view.state.sliceDoc(range.from, range.to))
        .join(view.state.lineBreak);
      const selectionStart = lspPositionFromOffset(
        view.state.doc,
        Math.min(selection.from, selection.to),
      );
      const selectionEnd = lspPositionFromOffset(
        view.state.doc,
        Math.max(selection.from, selection.to),
      );
      handler({
        position: lspPositionFromOffset(view.state.doc, selection.head),
        selectionStart,
        selectionEnd,
        clientX: event.clientX,
        clientY: event.clientY,
        hasSelection: selectedRanges.length > 0,
        selectedText,
        cut: () => cutSystemClipboard(view),
        copy: () => {
          writeEditorSelectionToClipboard(view);
          view.focus();
        },
        paste: () => pasteSystemClipboard(view),
      });
      return true;
    },
  });
}
