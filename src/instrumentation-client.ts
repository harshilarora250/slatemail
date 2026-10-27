import { setAnalyticsRuntimeEnabled } from "@/analytics/client";
import { loadPreferences } from "@/client/preferences";

// PostHog runs before hydration only when the saved preference allows it.
try {
  setAnalyticsRuntimeEnabled(loadPreferences().analyticsEnabled);
} catch {
  setAnalyticsRuntimeEnabled(false);
}
