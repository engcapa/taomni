import { measureVisualPositions } from "./geometry";
import { paddingForOverflow, setVirtualHead, virtualSpaceClickHandler, virtualSpaceTypingHandler } from "./input";
import { virtualOverflowAt } from "./overflow";


export const VirtualSpaceController = {
  measureVisualPositions,
  virtualOverflowAt,
  setVirtualHead,
  typingHandler: virtualSpaceTypingHandler,
  clickHandler: virtualSpaceClickHandler,
  paddingForOverflow,
};
