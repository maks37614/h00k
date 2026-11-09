/** Bybit packets contain an unstable local index instead of an exchange event ID.
 * Normalize only the trailing packet index (7-part server event key). */
export function canonicalLiquidationId(id: string): string {
  const parts = id.split(':');
  return parts.length === 7 && parts[0] === 'byb' && /^\d+$/.test(parts[6])
    ? parts.slice(0, 6).join(':') : id;
}

/** Deduplicate the chart feed too: labels and cascade calculations must not
 * count a replayed exchange event more than once. Preserve the largest
 * cumulative fill if a Binance liquidation order is updated. */
export function deduplicateLiquidations<T extends { id: string; usd: number }>(rows: readonly T[]): T[] {
  const unique = new Map<string, T>();
  for (const row of rows) {
    const id = canonicalLiquidationId(row.id);
    const previous = unique.get(id);
    if (!previous || row.usd > previous.usd) unique.set(id, { ...row, id });
  }
  return [...unique.values()];
}

/** Liquidation mark visibility. Never modifies the received/source rows. */
export type LiquidationDisplayPreferences = {
  showLiquidationLong?: boolean;
  showLiquidationShort?: boolean;
  /** null/undefined = automatic adaptive cutoff; 0 = show all. */
  liquidationLongMinUsd?: number | null;
  liquidationShortMinUsd?: number | null;
};

export type VisibleLiquidation = { side: 'LONG' | 'SHORT'; usd: number };

export function filterVisibleLiquidations<T extends VisibleLiquidation>(
  rows: readonly T[],
  automaticCut: number,
  preferences: LiquidationDisplayPreferences,
  maxRows = 160,
): T[] {
  const filtered = rows.filter(row => {
    if (!Number.isFinite(row.usd) || row.usd <= 0) return false;
    const isLong = row.side === 'LONG';
    if (isLong ? preferences.showLiquidationLong === false : preferences.showLiquidationShort === false) return false;
    const manual = isLong ? preferences.liquidationLongMinUsd : preferences.liquidationShortMinUsd;
    if (manual == null) return automaticCut > 0 && row.usd >= automaticCut;
    return Number.isFinite(manual) && manual >= 0 && row.usd >= manual;
  });
  const limit = Number.isFinite(maxRows) ? Math.max(0, Math.floor(maxRows)) : 160;
  return limit === 0 ? [] : filtered.slice(-limit);
}
