import { createTimedRequestCache } from './sharedAnalysisKlines';

/**
 * Deduplicate public chart-support requests across all HookCharts in a tab.
 * Only data common to all users/graphs is cached; replay/order/user endpoints
 * must never call this helper. Rejected requests are evicted by the cache.
 */
const minuteCache = createTimedRequestCache<any>(55_000, 256);
const fundingHistoryCache = createTimedRequestCache<any>(10 * 60_000, 128);

export function fetchSharedChartJson(url: string, category: 'minute' | 'funding-history' = 'minute'): Promise<any> {
  const cache = category === 'funding-history' ? fundingHistoryCache : minuteCache;
  // A funding settlement always creates a fresh key even when an earlier
  // response was cached minutes before 00:00, 08:00 or 16:00 UTC.
  const key = category === 'funding-history'
    ? url + ':' + Math.floor(Date.now() / (5 * 60_000))
    : url;
  return cache.load(key, async () => {
    const response = await fetch(url, { cache: 'no-store' });
    if (!response.ok) throw new Error('Chart data HTTP ' + response.status);
    return response.json();
  });
}
