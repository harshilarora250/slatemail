// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_PREFERENCES, loadPreferences, savePreferences } from "@/client/preferences";

const values = new Map<string, string>();
const storage = {
  getItem: (key: string) => values.get(key) ?? null,
  setItem: (key: string, value: string) => { values.set(key, value); },
  clear: () => values.clear(),
};

beforeEach(() => {
  values.clear();
  vi.stubGlobal("window", { localStorage: storage, dispatchEvent: vi.fn() });
  vi.stubGlobal("CustomEvent", class { constructor(readonly type: string, readonly init?: unknown) {} });
});

afterEach(() => {
  values.clear();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe("appearance and analytics preferences", () => {
  it("persists layout and theme preferences, constraining pane widths", () => {
    savePreferences({ ...DEFAULT_PREFERENCES, theme: "dark", accent: "violet", sidebarWidth: 500, listWidth: 280 });
    expect(loadPreferences()).toMatchObject({ theme: "dark", accent: "violet", sidebarWidth: 340, listWidth: 300 });
  });

  it("starts analytics disabled when the deployment requires consent", () => {
    vi.stubEnv("NEXT_PUBLIC_POSTHOG_REQUIRES_CONSENT", "true");
    expect(loadPreferences().analyticsEnabled).toBe(false);
    const accepted = { ...DEFAULT_PREFERENCES, analyticsEnabled: true, analyticsConsentGiven: true };
    savePreferences(accepted);
    expect(loadPreferences().analyticsEnabled).toBe(true);
  });
});
