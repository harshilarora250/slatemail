export function historyCursorExpired(status: number | undefined): boolean {
  return status === 404;
}

export function requiresHistoryRebuild(changedThreadCount: number, maximumIncrementalThreads = 100): boolean {
  return changedThreadCount > maximumIncrementalThreads;
}
