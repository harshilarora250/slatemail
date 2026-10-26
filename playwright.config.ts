import { defineConfig, devices } from "@playwright/test";

const baseURL = "http://127.0.0.1:3210";

export default defineConfig({
  testDir: "./tests/e2e",
  fullyParallel: true,
  reporter: "list",
  use: {
    baseURL,
    trace: "retain-on-failure",
    ...devices["Desktop Chrome"],
  },
  webServer: {
    command: "npm run dev -- --hostname 127.0.0.1 --port 3210",
    url: baseURL,
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
    env: {
      ...process.env,
      APP_URL: baseURL,
      GOOGLE_REDIRECT_URI: `${baseURL}/api/auth/google/callback`,
      DATABASE_PATH: "./data/playwright.sqlite",
    },
  },
});
