import type { MarketCoin, TerminalChartBlock, TerminalSavedPreset, Timeframe } from '../types';
import { coinMarketKey } from './marketPresets';

/** Preserve the real quote currency instead of silently forcing every pair to USDT. */
export function normalizeTerminalMarketPair(symbolInput: string, quoteInput?: string): { symbol: string; quoteAsset: string } {
  const quoteAsset = (quoteInput || 'USDT').toUpperCase().replace(/[^A-Z0-9]/g, '') || 'USDT';
  const cleanSymbol = (symbolInput || 'BTCUSDT').toUpperCase().replace(/[^A-Z0-9]/g, '');
  const symbol = cleanSymbol.length > quoteAsset.length && cleanSymbol.endsWith(quoteAsset)
    ? cleanSymbol : `${cleanSymbol}${quoteAsset}`;
  return { symbol, quoteAsset };
}

export const TERMINAL_PRESETS_STORAGE_KEY = 'crypto_screener_terminal_presets';
export function terminalStorageKey(key: string, uid?: string): string {
  return `${key}_${uid || 'guest'}`;
}

export function normalizeTerminalBlocks(value: unknown): TerminalChartBlock[] {
  if (!Array.isArray(value)) return [];
  const usedIds = new Set<string>();
  return value.flatMap((entry, index): TerminalChartBlock[] => {
    if (!entry || typeof entry !== 'object') return [];
    const block = entry as Record<string, unknown>;
    if (typeof block.id !== 'string' || typeof block.symbol !== 'string' || !block.symbol.length
      || !['binance', 'bybit'].includes(String(block.exchange))
      || !['spot', 'futures'].includes(String(block.marketType))
      || !['1m', '5m', '15m', '1h', '4h', '1d'].includes(String(block.timeframe))) return [];

    // Older saved workspaces included orderbook blocks; retain their symbol as a chart.
    const { mode: _legacyMode, domSettings: _legacyDomSettings, ...chartBlock } = block;
    // Old/imported workspaces can contain duplicate block IDs. Keeping duplicate
    // React keys would swap chart state between instruments after reordering.
    let id = block.id as string;
    if (usedIds.has(id)) {
      id = `${id}-restored-${index}`;
      while (usedIds.has(id)) id += '-1';
    }
    usedIds.add(id);
    return [{ ...chartBlock, id } as unknown as TerminalChartBlock];
  });
}

export function normalizeTerminalPresets(value: unknown): TerminalSavedPreset[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  return value.flatMap(preset => {
    if (!preset || typeof preset.id !== 'string' || seen.has(preset.id)
      || typeof preset.name !== 'string' || !preset.name.trim()) return [];
    const blocks = normalizeTerminalBlocks(preset.blocks).slice(0, 50);
    if (!blocks.length) return [];
    seen.add(preset.id);
    return [{ ...preset, name: preset.name.trim().slice(0, 60), blocks,
      columns: [1, 2, 3, 4, 5, 6].includes(preset.columns) ? preset.columns : 2,
      blockHeight: ['compact', 'medium', 'large'].includes(preset.blockHeight) ? preset.blockHeight : 'medium',
      createdAt: Number.isFinite(preset.createdAt) ? preset.createdAt : 0 }];
  }).slice(0, 30);
}

/** Keep existing widget IDs and settings when the market ranking is unchanged. */
export function blocksForMarketPreset(current: TerminalChartBlock[], coins: MarketCoin[], timeframe: Timeframe): TerminalChartBlock[] {
  const next = coins.map(coin => {
    const existing = current.find(block => coinMarketKey(block) === coinMarketKey(coin));
    if (existing) return existing;
    return { id: `market-${coinMarketKey(coin)}`, symbol: coin.symbol, baseAsset: coin.baseAsset,
      quoteAsset: coin.quoteAsset, exchange: coin.exchange, marketType: coin.marketType,
      timeframe, colSpan: 1 as const };
  });
  return next.length === current.length && next.every((block, index) => block === current[index]) ? current : next;
}
