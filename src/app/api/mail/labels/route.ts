import { NextRequest, NextResponse } from "next/server";
import { getLabels } from "@/providers/gmail/gmail-provider";
import { getSessionAccount } from "@/server/session";
import { failure, invalidSession } from "@/server/http";

export const runtime = "nodejs";

export async function GET(request: NextRequest) {
  const account = getSessionAccount(request);
  if (!account) return invalidSession();
  try {
    return NextResponse.json({ labels: await getLabels(account) }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return failure(error, "Unable to load Gmail labels.");
  }
}
