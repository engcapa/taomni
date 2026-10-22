import "./tests/fileToolbarWiring/harness";
import { cleanup } from "@testing-library/react";
import { afterEach, beforeEach, vi } from "vitest";
import { setLocale } from "../../lib/i18n";
import { SFTP_PREFERENCES_STORAGE_KEY } from "../../lib/sftpPreferences";
import { useSftpStore } from "../../stores/sftpStore";
import { registerFileToolbarWiringLayout1Cases } from "./tests/fileToolbarWiring/layout1.cases";
import { registerFileToolbarWiringLayout2Cases } from "./tests/fileToolbarWiring/layout2.cases";

beforeEach(() => {
  useSftpStore.setState({ sessions: {} });
});

afterEach(() => {
  cleanup();
  useSftpStore.setState({ sessions: {} });
  setLocale("en");
  localStorage.removeItem(SFTP_PREFERENCES_STORAGE_KEY);
  vi.clearAllMocks();
});

registerFileToolbarWiringLayout1Cases();

registerFileToolbarWiringLayout2Cases();
