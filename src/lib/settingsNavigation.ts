/** Cross-component navigation into a Settings section (status bar, menus, etc.). */

export const OPEN_SETTINGS_SECTION_EVENT = "taomni:open-settings-section";

export interface OpenSettingsSectionDetail {
  id: string;
  /** When opening language-servers, scroll to this LSP preset row (e.g. "csharp"). */
  presetId?: string | null;
}

let pendingSection: OpenSettingsSectionDetail | null = null;

export function consumePendingSettingsSection(): OpenSettingsSectionDetail | null {
  return pendingSection;
}

export function clearPendingSettingsSection(): void {
  pendingSection = null;
}

export function openSettingsSection(
  id: string,
  options?: { presetId?: string | null },
): void {
  pendingSection = { id, presetId: options?.presetId ?? null };
  if (typeof window === "undefined") return;
  try {
    window.dispatchEvent(
      new CustomEvent<OpenSettingsSectionDetail>(OPEN_SETTINGS_SECTION_EVENT, {
        detail: pendingSection,
      }),
    );
  } catch {
    // CustomEvent may be unavailable.
  }
}