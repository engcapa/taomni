/// <reference types="vite/client" />

declare const __APP_VERSION__: string;

/**
 * ED-PARITY-002: true only in the isolated QA bundle (`vite build --mode qa`,
 * used by the qa-ui-auto `com.taomni.app.qa` binary). Normal builds compile the
 * save-race probe install branch away.
 */
declare const __TAOMNI_QA_SAVE_GATE__: boolean;
