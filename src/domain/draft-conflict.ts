export function remoteDraftVersionConflicts(expectedVersion: string | undefined, currentVersion: string): boolean {
  return !expectedVersion || expectedVersion !== currentVersion;
}
