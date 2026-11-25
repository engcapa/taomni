import { type TerminalProfile } from "../../../lib/terminalProfile";
import { TerminalAppearanceSettings } from "../../terminal/TerminalAppearanceSettings";


export function TerminalSettings({
  profile,
  onProfileChange,
}: {
  profile: TerminalProfile;
  onProfileChange: (profile: TerminalProfile) => void;
}) {
  return (
    <div data-testid="terminal-settings" className="text-ui-body">
      <TerminalAppearanceSettings
        profile={profile}
        onProfileChange={onProfileChange}
        showCustomColors
        allowSystemTheme
      />
    </div>
  );
}
