


/** Output still accepted after `terminated` before the session is freed. */
export const CLOSING_OUTPUT_DRAIN_MS=250;


/** Fallback when an adapter reports `exited` but never `terminated`. */
export const EXITED_WITHOUT_TERMINATED_MS=1500;


export const MAX_MEMORY_REFERENCE_LENGTH=4096;


export const MAX_MEMORY_READ_BYTES=65536;


export const MAX_DISASSEMBLE_INSTRUCTIONS=4096;


/** Frames fetched per `stackTrace` page (the first page and each "load more"). */
export const FRAME_PAGE_SIZE=40;
