export { VIRTUAL_SPACE_KNOWN_GAPS, editorVirtualSpacePolicy, type EditorVirtualSpacePolicy } from "./virtualSpace/policy";

export {
  desiredVisualColumnField,
  setDesiredVisualColumns,
  setVirtualOverflow,
  setVirtualOverflowRestore,
  virtualOverflowAt,
  virtualOverflowRestoreField,
  virtualSpaceOverflowField,
  type VirtualOverflowMap,
} from "./virtualSpace/overflow";

export {
  charVisualWidth,
  documentColumnForVisualColumn,
  isEditorGeometryReady,
  measureVisualPositions,
  resolveTargetVisualBlock,
  visualColumnFor,
  type TargetVisualBlock,
  type VisualColumnPosition,
} from "./virtualSpace/geometry";

export {
  paddingForOverflow,
  setVirtualHead,
  virtualBackspaceCommand,
  virtualDeleteCommand,
  virtualEnterCommand,
  virtualEscapeCommand,
  virtualHomeCommand,
  virtualLineEndCommand,
  virtualMoveLeftCommand,
  virtualMoveRightCommand,
  virtualSpaceClickHandler,
  virtualSpaceTypingHandler,
  virtualTabCommand,
} from "./virtualSpace/input";

export {
  virtualMoveDown,
  virtualMoveUp,
  virtualPageDown,
  virtualPageUp,
  virtualSelectDown,
  virtualSelectPageDown,
  virtualSelectPageUp,
  virtualSelectUp,
  virtualVerticalMoveCommand,
} from "./virtualSpace/vertical";

export { VirtualSpaceController } from "./virtualSpace/controller";
