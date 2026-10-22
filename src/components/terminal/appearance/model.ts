import { type TranslateFn } from "../../../lib/i18n";
import { type SystemFontState } from "../../../lib/systemFonts";
import { type TerminalProfile, type UserCommonCommand } from "../../../lib/terminalProfile";

export interface TerminalAppearanceSettingsProps {
  profile: TerminalProfile;
  onProfileChange: (profile: TerminalProfile) => void;
  showCustomColors?: boolean;
  showPreview?: boolean;
  allowSystemTheme?: boolean;
  className?: string;
  fontState?: SystemFontState;
  onRequestSystemFonts?: () => void;
}

export interface CommonCommandsEditorProps {
  value: UserCommonCommand[];
  onChange: (next: UserCommonCommand[]) => void;
  t: TranslateFn;
}
