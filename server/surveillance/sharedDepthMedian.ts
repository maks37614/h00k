import { lowerMedian } from './lowerMedian';

/**
 * Cache the public portion of the AUTO/HYBRID liquidity threshold once for
 * each canonical shared order-book revision. Every account still computes
 * its own turnover baseline, manual threshold and persistence score.
 *
 * WeakMap lifetime follows the shared market Map; no account keys or user
 * settings are ever retained. Revisions advance on a real book mutation or
 * full snapshot/resync, including clearing books after an outage.
 */
export class SharedPublicDepthMedianCache {
  private rows = new WeakMap<ReadonlyMap<number, number>, {
    asks: ReadonlyMap<number, number>; revision: number; median: number | null;
  }>();
  private calculations = 0;
  private hits = 0;

  get(bids: ReadonlyMap<number, number>, asks: ReadonlyMap<number, number>,
    revision: number): number | null {
    if (!Number.isSafeInteger(revision) || revision < 0)
      throw new Error('Invalid shared depth revision');
    const row = this.rows.get(bids);
    if (row && row.asks === asks && row.revision === revision) {
      this.hits++;
      return row.median;
    }
    const notionals: number[] = [];
    for (const [p, q] of bids) notionals.push(p * q);
    for (const [p, q] of asks) notionals.push(p * q);
    const median = notionals.length ? lowerMedian(notionals) : null;
    this.calculations++;
    this.rows.set(bids, { asks, revision, median });
    return median;
  }

  stats() { return { calculations: this.calculations, hits: this.hits }; }
}

export const sharedPublicDepthMedian = new SharedPublicDepthMedianCache();
