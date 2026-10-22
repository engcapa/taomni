import { cloneCaretVertically } from "./clipboard";

export const cloneCaretAbove = cloneCaretVertically(-1);

export const cloneCaretBelow = cloneCaretVertically(1);
