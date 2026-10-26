import "server-only";
import { NextResponse } from "next/server";
import { ExternalProviderError } from "@/providers/ai/external";
import { failure } from "@/server/http";

export function aiFailure(error: unknown, fallback: string): NextResponse {
  if (error instanceof ExternalProviderError) return NextResponse.json({ error: error.message }, { status: error.status });
  return failure(error, fallback);
}
