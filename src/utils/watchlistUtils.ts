import { ExchangeId, MarketType, ScannedCoin } from '../types';

export interface CoinIdentifier {
  symbol: string;
  exchange?: ExchangeId | string;
  marketType?: MarketType | string;
}

/**
 * Returns a standardized, unique key for a coin: `${exchange}:${marketType}:${symbol}`
 * e.g. "bybit:futures:BTCUSDT", "binance:futures:BTCUSDT", "binance:spot:ETHUSDT"
 */
export function getCoinWatchlistKey(coin: CoinIdentifier | string): string {
  if (typeof coin === 'string') {
    const trimmed = coin.trim();
    if (trimmed.includes(':')) {
      const parts = trimmed.split(':');
      if (parts.length >= 3) {
        return `${parts[0].toLowerCase()}:${parts[1].toLowerCase()}:${parts.slice(2).join(':').toUpperCase()}`;
      }
      if (parts.length === 2) {
        return `${parts[0].toLowerCase()}:futures:${parts[1].toUpperCase()}`;
      }
    }
    // Default legacy symbol to binance:futures
    return `binance:futures:${trimmed.toUpperCase()}`;
  }

  const ex = (coin.exchange || 'binance').toLowerCase().trim();
  const mt = (coin.marketType || 'futures').toLowerCase().trim();
  const sym = coin.symbol.toUpperCase().trim();
  return `${ex}:${mt}:${sym}`;
}

/**
 * Parses a standardized watchlist key back into its component parts:
 * exchange, marketType, and symbol.
 */
export function parseWatchlistKey(key: string): { exchange: ExchangeId; marketType: MarketType; symbol: string } {
  const parts = key.trim().split(':');
  if (parts.length >= 3) {
    return {
      exchange: (parts[0].toLowerCase() === 'bybit' ? 'bybit' : 'binance') as ExchangeId,
      marketType: (parts[1].toLowerCase() === 'spot' ? 'spot' : 'futures') as MarketType,
      symbol: parts.slice(2).join(':').toUpperCase(),
    };
  }
  if (parts.length === 2) {
    return {
      exchange: (parts[0].toLowerCase() === 'bybit' ? 'bybit' : 'binance') as ExchangeId,
      marketType: 'futures',
      symbol: parts[1].toUpperCase(),
    };
  }
  return {
    exchange: 'binance',
    marketType: 'futures',
    symbol: key.toUpperCase(),
  };
}

/**
 * Checks whether a given coin matches any item in the watchlist.
 * Guarantees that adding a coin on one exchange (e.g. Bybit) does NOT
 * falsely match or add the coin on another exchange (e.g. Binance).
 */
export function isCoinInWatchlist(
  watchlist: string[] | undefined,
  coin: CoinIdentifier | string
): boolean {
  if (!watchlist || !Array.isArray(watchlist) || watchlist.length === 0) return false;

  const targetKey = getCoinWatchlistKey(coin);
  // Legacy plain-symbol entries are treated as historical Binance Futures
  // entries. Never mark a Bybit (or Spot) coin as saved merely because
  // another exchange has the same ticker.
  if (watchlist.some((item) => getCoinWatchlistKey(item) === targetKey)) return true;

  if (typeof coin !== 'string') {
    const ex = (coin.exchange || '').toLowerCase().trim();
    const mt = (coin.marketType || '').toLowerCase().trim();
    const sym = coin.symbol.toUpperCase().trim();

    if (!ex) return false;

    for (const item of watchlist) {
      if (item === targetKey) return true;
      if (item.includes(':')) {
        const itemParsed = parseWatchlistKey(item);
        if (itemParsed.symbol === sym && itemParsed.exchange === ex) {
          if (!mt || itemParsed.marketType === mt) {
            return true;
          }
        }
      }
    }
  }

  return false;
}

/**
 * Normalizes an array of watchlist keys to ensure backwards compatibility
 * while guaranteeing each entry has an explicit exchange identifier.
 */
export function normalizeWatchlist(list: string[] | undefined): string[] {
  if (!list || !Array.isArray(list)) return [];
  const normalized = list.map((item) => getCoinWatchlistKey(item));
  return Array.from(new Set(normalized));
}

/** Toggle a single exact exchange+market+symbol pair without losing old entries. */
export function toggleCoinWatchlist(
  watchlist: string[],
  coin: CoinIdentifier | string
): string[] {
  const key = getCoinWatchlistKey(coin);
  const existing = watchlist.some((item) => getCoinWatchlistKey(item) === key);
  return existing
    ? watchlist.filter((item) => getCoinWatchlistKey(item) !== key)
    : [...watchlist, key];
}

/** Clear old folder assignments only when a favorite is explicitly removed.
 * Adding a favorite must NEVER auto-place it in an existing folder.
 */
export function removeCoinFromWatchlistFolders(
  folders: Record<string, string[]>,
  coin: CoinIdentifier | string
): Record<string, string[]> {
  const key = getCoinWatchlistKey(coin);
  const result: Record<string, string[]> = {};
  for (const [name, entries] of Object.entries(folders)) {
    result[name] = Array.isArray(entries)
      ? entries.filter((entry) => getCoinWatchlistKey(entry) !== key)
      : [];
  }
  return result;
}

/** A saved favorite can outlive the current scan. Keep it visible and removable. */
export interface ResolvedWatchlistEntry {
  key: string;
  sourceKeys: string[];
  symbol: string;
  exchange: string;
  marketType: string;
  coin: ScannedCoin | null;
}

/**
 * Resolve both legacy symbol-only and fully qualified saved favorites.
 * Scanner results can temporarily omit a saved coin; an unresolved favorite
 * must remain visible (and removable), rather than inflate a hidden counter.
 */
export function resolveWatchlistEntries(
  watchlist: string[] | undefined,
  scannedCoins: ScannedCoin[]
): ResolvedWatchlistEntry[] {
  const available = new Map<string, ScannedCoin>();
  for (const coin of scannedCoins) {
    const key = getCoinWatchlistKey(coin);
    if (!available.has(key)) available.set(key, coin);
  }
  const resolved = new Map<string, ResolvedWatchlistEntry>();
  for (const raw of Array.isArray(watchlist) ? watchlist : []) {
    if (typeof raw !== 'string' || !raw.trim()) continue;
    const sourceKey = raw.trim();
    const normalized = getCoinWatchlistKey(sourceKey);
    const parsed = parseWatchlistKey(normalized);
    if (!parsed.symbol.trim()) continue;
    // Legacy plain symbols had no exchange recorded. Treat them as the
    // historical Binance Futures default; do not substitute a Bybit quote
    // merely because it shares the same symbol.
    const coin = available.get(normalized) ?? null;
    const existing = resolved.get(normalized);
    if (existing) {
      if (!existing.sourceKeys.includes(raw)) existing.sourceKeys.push(raw);
      if (!existing.coin && coin) existing.coin = coin;
    } else {
      resolved.set(normalized, {
        key: normalized,
        sourceKeys: [raw],
        symbol: parsed.symbol,
        exchange: coin?.exchange || parsed.exchange,
        marketType: coin?.marketType || parsed.marketType,
        coin,
      });
    }
  }
  return [...resolved.values()];
}
