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

/** Fresh empty arrays and unchanged depth counters must not trigger a React
 * redraw in each idle chart's once-per-second hold-time refresh. */
export function equalDepthAutoStats(
  a: { baseline: number; bidCut: number; askCut: number; buy5m: number; sell5m: number },
  b: { baseline: number; bidCut: number; askCut: number; buy5m: number; sell5m: number },
): boolean {
  return a.baseline === b.baseline && a.bidCut === b.bidCut &&
    a.askCut === b.askCut && a.buy5m === b.buy5m && a.sell5m === b.sell5m;
}
