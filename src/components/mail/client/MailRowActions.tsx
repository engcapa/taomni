import { type DragEvent as ReactDragEvent, type MouseEvent as ReactMouseEvent } from "react";
import { type MailMessageHeader } from "../../../lib/mail";


export type MailRowActions = {
  selectListMessage: (message: MailMessageHeader) => void;
  openMessageTab: (message: MailMessageHeader) => void;
  toggleMessageChecked: (message: MailMessageHeader, checked: boolean, range?: boolean) => void;
  toggleThreadExpanded: (key: string) => void;
  contextMenu: (event: ReactMouseEvent, message: MailMessageHeader) => void;
  dragStart: (event: ReactDragEvent, message: MailMessageHeader) => void;
  dragEnd: () => void;
};
