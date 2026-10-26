// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";

const analytics = vi.hoisted(() => ({
  init: vi.fn(),
  capture: vi.fn(),
  optIn: vi.fn(),
  optOut: vi.fn(),
  stopSessionRecording: vi.fn(),
  setConfig: vi.fn(),
}));

vi.mock("posthog-js", () => ({
  default: {
    init: analytics.init,
    capture: analytics.capture,
    opt_in_capturing: analytics.optIn,
    opt_out_capturing: analytics.optOut,
    stopSessionRecording: analytics.stopSessionRecording,
    set_config: analytics.setConfig,
  },
}));

import { captureOptional, setAnalyticsRuntimeEnabled } from "@/analytics/client";

beforeEach(() => {
  vi.stubEnv("NEXT_PUBLIC_POSTHOG_PROJECT_TOKEN", "phc_test_project_key");
});

describe("PostHog immediate opt-out", () => {
  it("uses only allowlisted property-free events and blocks capture after opt-out", () => {
    setAnalyticsRuntimeEnabled(true);
    captureOptional("settings_opened");
    for (const event of ["mailbox_opened", "message_opened", "compose_opened", "search_used", "message_send_confirmed", "local_ai_action_completed", "ai_provider_settings_opened", "local_ai_actions_opened"]) {
      captureOptional(event);
    }
    captureOptional("mail_subject_viewed");

    expect(analytics.init).toHaveBeenCalledOnce();
    expect(analytics.capture).toHaveBeenCalledTimes(9);
    expect(analytics.capture).toHaveBeenCalledWith("settings_opened");
    const configuration = analytics.init.mock.calls[0]?.[1] as { autocapture: boolean; capture_pageview: boolean; disable_session_recording: boolean; before_send: (event: { event: string; properties: Record<string, unknown> }) => { properties: Record<string, unknown> } | null };
    expect(configuration).toMatchObject({ autocapture: false, capture_pageview: false, disable_session_recording: true });
    expect(configuration.before_send({ event: "settings_opened", properties: { email: "private@example.test", query: "secret" } })?.properties).toEqual({});

    setAnalyticsRuntimeEnabled(false);
    captureOptional("theme_changed");
    expect(analytics.capture).toHaveBeenCalledTimes(9);
    expect(analytics.stopSessionRecording).toHaveBeenCalledOnce();
    expect(analytics.optOut).toHaveBeenCalledOnce();

    window.history.pushState({}, "", "/privacy");
    expect(analytics.init).toHaveBeenCalledOnce();
    expect(analytics.capture).toHaveBeenCalledTimes(9);

    vi.stubEnv("NEXT_PUBLIC_POSTHOG_PROJECT_TOKEN", "");
    vi.stubEnv("NEXT_PUBLIC_POSTHOG_KEY", "");
    setAnalyticsRuntimeEnabled(true);
    captureOptional("application_opened");
    expect(analytics.capture).toHaveBeenCalledTimes(9);
  });
});
