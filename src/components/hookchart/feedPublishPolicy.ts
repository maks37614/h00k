/**
 * Preserve all active event/hold-time updates while avoiding React writes for
 * unchanged empty live data (especially many idle Terminal graphs).
 */
export function shouldPublishDepthView(ready: boolean, wasReady: boolean): boolean {
  return ready || wasReady;
}

/** Keep periodic cascade expiry while rows exist; emit the final empty state once. */
export function shouldPublishLiquidationView(rowsRemaining: number, previouslyHadRows: boolean): boolean {
  return rowsRemaining > 0 || previouslyHadRows;
}
