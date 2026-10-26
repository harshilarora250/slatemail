import { z } from "zod";

const environmentSchema = z.object({
  APP_URL: z.string().url().optional(),
  GOOGLE_CLIENT_ID: z.string().min(1).optional(),
  GOOGLE_CLIENT_SECRET: z.string().min(1).optional(),
  GOOGLE_REDIRECT_URI: z.string().url().optional(),
  SESSION_SECRET: z.string().min(32).optional(),
  APP_ENCRYPTION_KEY: z.string().min(1).optional(),
  DATABASE_PATH: z.string().min(1).optional(),
});

export const env = environmentSchema.parse(process.env);

export function requireGoogleConfig() {
  const { GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, GOOGLE_REDIRECT_URI } = env;
  if (!GOOGLE_CLIENT_ID || GOOGLE_CLIENT_ID.startsWith("your-") || !GOOGLE_CLIENT_SECRET || GOOGLE_CLIENT_SECRET.startsWith("replace-") || !GOOGLE_REDIRECT_URI) {
    throw new Error("Google sign-in is not configured. Add the Google OAuth variables to the server environment.");
  }
  return { clientId: GOOGLE_CLIENT_ID, clientSecret: GOOGLE_CLIENT_SECRET, redirectUri: GOOGLE_REDIRECT_URI };
}

export function appUrl(): string {
  const value = env.APP_URL ?? "http://localhost:3000";
  return new URL(value).origin;
}
