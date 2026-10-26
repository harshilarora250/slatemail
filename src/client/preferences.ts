export type ThemePreference = "system" | "light" | "dark";
export type AccentPreference = "blue" | "violet" | "green" | "orange";
export type DensityPreference = "compact" | "comfortable";
export type PaneArrangement = "vertical" | "horizontal";

export interface UserPreferences {
  theme: ThemePreference;
  accent: AccentPreference;
  density: DensityPreference;
  sidebarVisible: boolean;
  sidebarWidth: number;
  listWidth: number;
  readingWidth: number;
  paneArrangement: PaneArrangement;
  analyticsEnabled: boolean;
  analyticsConsentGiven: boolean;
  shortcutsEnabled: boolean;
}

export const DEFAULT_PREFERENCES: UserPreferences = {
  theme: "system",
  accent: "blue",
  density: "comfortable",
  sidebarVisible: true,
  sidebarWidth: 232,
  listWidth: 368,
  readingWidth: 620,
  paneArrangement: "vertical",
  analyticsEnabled: true,
  analyticsConsentGiven: false,
  shortcutsEnabled: true,
};

const STORAGE_KEY = "slatemail-preferences-v1";

export function loadPreferences(): UserPreferences {
  if (typeof window === "undefined") return DEFAULT_PREFERENCES;
  const consentRequired = process.env.NEXT_PUBLIC_POSTHOG_REQUIRES_CONSENT === "true";
  const defaults = consentRequired ? { ...DEFAULT_PREFERENCES, analyticsEnabled: false } : DEFAULT_PREFERENCES;
  try {
    const value: unknown = JSON.parse(window.localStorage.getItem(STORAGE_KEY) ?? "null");
    if (value === null || typeof value !== "object") return defaults;
    const source = value as Partial<UserPreferences>;
    return {
      ...DEFAULT_PREFERENCES,
      ...source,
      analyticsEnabled: consentRequired && source.analyticsConsentGiven !== true ? false : source.analyticsEnabled ?? defaults.analyticsEnabled,
      sidebarWidth: clamp(source.sidebarWidth, 180, 340, DEFAULT_PREFERENCES.sidebarWidth),
      listWidth: clamp(source.listWidth, 300, 560, DEFAULT_PREFERENCES.listWidth),
      readingWidth: clamp(source.readingWidth, 400, 1200, DEFAULT_PREFERENCES.readingWidth),
    };
  } catch {
    return defaults;
  }
}

export function savePreferences(preferences: UserPreferences): void {
  if (typeof window === "undefined") return;
  window.localStorage.setItem(STORAGE_KEY, JSON.stringify(preferences));
  window.dispatchEvent(new CustomEvent("slatemail:preferences", { detail: preferences }));
}

function clamp(value: unknown, min: number, max: number, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value)
    ? Math.min(max, Math.max(min, value))
    : fallback;
}
