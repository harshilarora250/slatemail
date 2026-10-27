"use client";

import { useEffect } from "react";
import posthog from "posthog-js";

const allowedEvents = new Set([
  "application_opened",
  "mailbox_opened",
  "message_opened",
  "compose_opened",
  "search_used",
  "message_send_confirmed",
  "settings_opened",
  "theme_changed",
  "ai_provider_settings_opened",
  "local_ai_actions_opened",
  "local_ai_action_completed",
]);

let initialized = false;
let captureEnabled = false;

function startAnalytics(): void {
  const key = process.env.NEXT_PUBLIC_POSTHOG_PROJECT_TOKEN || process.env.NEXT_PUBLIC_POSTHOG_KEY;
  const host = process.env.NEXT_PUBLIC_POSTHOG_HOST || "https://us.i.posthog.com";
  if (!key) return;
  if (!initialized) {
    posthog.init(key, {
      api_host: host,
      defaults: "2026-08-30",
      autocapture: false,
      capture_pageview: false,
      capture_pageleave: false,
      disable_session_recording: true,
      persistence: "memory",
      person_profiles: "never",
      opt_out_capturing_by_default: true,
      before_send: (event) => {
        if (!captureEnabled || !event || !allowedEvents.has(event.event)) return null;
        event.properties = {};
        return event;
      },
    });
    initialized = true;
  }
  captureEnabled = true;
  posthog.opt_in_capturing();
  posthog.set_config({ autocapture: false, capture_pageview: false, disable_session_recording: true });
}

export function setAnalyticsRuntimeEnabled(enabled: boolean): void {
  if (!enabled) {
    captureEnabled = false;
    if (initialized) {
      posthog.stopSessionRecording();
      posthog.opt_out_capturing();
    }
    return;
  }
  if (!process.env.NEXT_PUBLIC_POSTHOG_PROJECT_TOKEN && !process.env.NEXT_PUBLIC_POSTHOG_KEY) {
    captureEnabled = false;
    return;
  }
  if (!initialized) startAnalytics();
  else {
    captureEnabled = true;
    posthog.opt_in_capturing();
    posthog.set_config({ autocapture: false, capture_pageview: false, disable_session_recording: true });
  }
}

export function captureOptional(event: string): void {
  if (!captureEnabled || !allowedEvents.has(event)) return;
  posthog.capture(event);
}

export function AnalyticsGate({ enabled, children }: { enabled: boolean | undefined; children: React.ReactNode }) {
  useEffect(() => {
    if (enabled !== undefined) setAnalyticsRuntimeEnabled(enabled);
  }, [enabled]);
  return children;
}
