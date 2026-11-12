/**
 * Reserve room for the volume histogram in a terminal chart without moving it.
 * The geometry is O(1); candle extrema come from the renderer's existing visible range.
 */
export function terminalCandlePriceRange(
  minimum: number,
  maximum: number,
  plotHeight: number,
  showVolumes: boolean,
): { low: number; high: number } {
  const low = Math.min(minimum, maximum);
  const high = Math.max(minimum, maximum);
  const spread = Math.max(high - low, Math.abs(high) * .01, 1e-12);
  const topPadding = spread * .12;
  const height = Math.max(80, plotHeight);
  const gapPx = Math.min(14, Math.max(8, height * .05));
  // Keep the lower wick above both the volume band and a clear visual gap.
  const volumeBandPx = showVolumes ? Math.max(56, Math.min(108, height * .14)) + 3 : 0;
  const reservedFraction = Math.min(.88, (volumeBandPx + gapPx) / height);
  const bottomPadding = reservedFraction * (spread + topPadding) / (1 - reservedFraction);
  return { low: low - bottomPadding, high: high + topPadding };
}
