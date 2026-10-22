
/** Windows AltGr arrives as a synthetic ControlLeft right before AltRight. */
export const ALTGR_PAIR_WINDOW_MS = 10;

export const ALTGR_FLUSH_MS = 100;


export const SPECIAL_KEY_KEYSYMS: Record<string, number> = {
  MetaLeft: 0xffeb,
  MetaRight: 0xffec,
  Tab: 0xff09,
  Escape: 0xff1b,
  PrintScreen: 0xff61,
};
