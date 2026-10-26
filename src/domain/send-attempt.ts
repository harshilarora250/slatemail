export type SendAttemptDisposition = "new" | "already-sent" | "uncertain";

export function sendAttemptDisposition(status: string | undefined): SendAttemptDisposition {
  if (status === "sent") return "already-sent";
  if (status === "pending" || status === "uncertain") return "uncertain";
  return "new";
}
