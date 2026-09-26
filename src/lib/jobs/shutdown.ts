/**
 * pg-boss aborts a handler's signal both when its job times out and when a graceful stop runs out of time. Only the
 * first is the item's fault; after the second the job is simply retried once the worker is back.
 */
let stopRequested = false;

export function markStopping(): void {
  stopRequested = true;
}

export function workerStopping(): boolean {
  return stopRequested;
}
