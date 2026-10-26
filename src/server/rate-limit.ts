import "server-only";

const windows = new Map<string, { count: number; resetAt: number }>();

export function allowRequests(key: string, maximum: number, windowMs: number, now = Date.now()): boolean {
  const current = windows.get(key);
  if (!current || current.resetAt <= now) {
    windows.set(key, { count: 1, resetAt: now + windowMs });
    if (windows.size > 10_000) {
      for (const [storedKey, state] of windows) if (state.resetAt <= now) windows.delete(storedKey);
    }
    return true;
  }
  if (current.count >= maximum) return false;
  current.count += 1;
  return true;
}
