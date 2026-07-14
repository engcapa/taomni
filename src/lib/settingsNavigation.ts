/** Cross-component navigation into a Settings section (status bar, menus, etc.). */

export const OPEN_SETTINGS_SECTION_EVENT = "taomni:open-settings-section";

export interface OpenSettingsSectionDetail {
  id: string;
}

export function openSettingsSection(id: string): void {
  if (typeof window === "undefined") return;
  try {
    window.dispatchEvent(
      new CustomEvent<OpenSettingsSectionDetail>(OPEN_SETTINGS_SECTION_EVENT, {
        detail: { id },
      }),
    );
  } catch {
    // CustomEvent may be unavailable.
  }
}
