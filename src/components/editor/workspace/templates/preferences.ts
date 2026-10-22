import { subscribeLiveTemplatePreferences, loadLiveTemplatePreferences, type LiveTemplatePreferences } from "../../../../lib/liveTemplatePreferences";

// Preferences cache so completion stays sync and settings apply immediately.
export let preferencesCache: LiveTemplatePreferences = loadLiveTemplatePreferences();

export function getLiveTemplatePreferencesCache(): LiveTemplatePreferences {
  return preferencesCache;
}

/** Test / settings helper: re-read storage into the in-memory cache. */
export function refreshLiveTemplatePreferencesCache(
  preferences?: LiveTemplatePreferences,
): LiveTemplatePreferences {
  preferencesCache = preferences ?? loadLiveTemplatePreferences();
  return preferencesCache;
}

if (typeof window !== "undefined") {
  subscribeLiveTemplatePreferences((next) => {
    preferencesCache = next;
  });
}
