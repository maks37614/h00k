import type { MarketSentimentData, MarketCoin } from '../src/types';
import { sentimentStateForScore } from '../src/utils/marketSentiment';
import { fetchMarketCoins } from './marketService';
import { getMarketSourceStatuses } from './marketTickerFeed';

let sentimentCache: { timestamp: number; data: MarketSentimentData } | null = null;
const CACHE_TTL_MS = 25_000;
const SMALL_MOVE_PCT = 0.1;
const MIN_LIVE_PAIRS = 25;
const clamp = (value: number, min: number, max: number) => Math.max(min, Math.min(max, value));

export class SentimentDataUnavailableError extends Error {
  constructor() {
    super('Недостатньо достовірних ринкових даних для індексу настрою');
    this.name = 'SentimentDataUnavailableError';
  }
}

/**
 * Directional heuristic based only on observed 24h price changes, 24h traded
 * volume and valid long-term price-location history (when available).
 *
 * This is NOT an exchange-wide fund-flow, EMA, open-interest or funding-rate
 * index. No derivatives figures or capital movements are inferred from volume.
 */
export async function calculateMarketSentiment(providedCoins?: MarketCoin[]): Promise<MarketSentimentData> {
  const isLiveRequest = providedCoins === undefined;
  const now = Date.now();
  if (isLiveRequest && sentimentCache && now - sentimentCache.timestamp < CACHE_TTL_MS) {
    return sentimentCache.data;
  }

  const fetchedCoins = isLiveRequest
    ? await fetchMarketCoins({ exchange: 'all', marketType: 'all', minVolumeUsd: 0 })
    : providedCoins;
  const coins = (fetchedCoins ?? []).filter(c =>
    Number.isFinite(c.price) && c.price > 0 &&
    Number.isFinite(c.change24h) && Number.isFinite(c.volumeUsd) && c.volumeUsd >= 0 &&
    Number.isFinite(c.volatility24hPct) && c.volatility24hPct >= 0,
  );
  if (!coins.length || (isLiveRequest && coins.length < MIN_LIVE_PAIRS)) {
    throw new SentimentDataUnavailableError();
  }

  const total = coins.length;
  let advancingCount = 0;
  let decliningCount = 0;
  let totalVolume24h = 0;
  let totalChange = 0;
  let totalVolatility = 0;
  let directionalStrengthSum = 0;
  let volumeWeightedDirectionSum = 0;
  let locationCount = 0;
  let nearHighCount = 0;
  let nearLowCount = 0;

  for (const c of coins) {
    const change = c.change24h;
    if (change > SMALL_MOVE_PCT) advancingCount++;
    else if (change < -SMALL_MOVE_PCT) decliningCount++;

    const direction = clamp(change / 2, -1, 1);
    directionalStrengthSum += direction;
    volumeWeightedDirectionSum += direction * c.volumeUsd;
    totalVolume24h += c.volumeUsd;
    totalChange += change;
    totalVolatility += c.volatility24hPct;

    // Missing/unfinished history is unknown, NOT zero near-high/low coins.
    if (c.location?.status === 'ready') {
      locationCount++;
      if (c.isNearHigh) nearHighCount++;
      if (c.isNearLow) nearLowCount++;
    }
  }

  const advancingPct = Number((advancingCount / total * 100).toFixed(1));
  const avgChange24h = Number((totalChange / total).toFixed(2));
  const avgVolatility = Number((totalVolatility / total).toFixed(2));
  const directionStrength = directionalStrengthSum / total;
  const volumeDirection = totalVolume24h > 0 ? volumeWeightedDirectionSum / totalVolume24h : 0;
  const locationCoverage = locationCount / total;
  const locationDirection = locationCount > 0 ? (nearHighCount - nearLowCount) / locationCount : 0;
  const trendBias: MarketSentimentData['priceTrendDynamics']['trendBias'] =
    directionStrength > 0.15 ? 'bullish' : directionStrength < -0.15 ? 'bearish' : 'neutral';

  // All 0% changes => exactly 50. Tiny price moves cannot flip the whole index.
  // Each continuous contribution has a bounded, documented maximum:
  // 20 breadth, 15 mean movement, 10 volume-weighted direction, 5 location.
  const rawScore = 50
    + 20 * directionStrength
    + 15 * clamp(avgChange24h / 5, -1, 1)
    + 10 * volumeDirection
    + 5 * locationDirection * locationCoverage;
  const compositeScore = Math.round(clamp(rawScore, 0, 100));
  const sentimentState = sentimentStateForScore(compositeScore);
  const sentimentLabels: Record<MarketSentimentData['sentimentState'], string> = {
    extreme_fear: 'Екстремальний страх / Сильний тиск продавців',
    fear: 'Страх / Переважають продавці',
    neutral: 'Нейтральний стан ринку (Баланс сил)',
    greed: 'Жадібність / Переважають покупці',
    extreme_greed: 'Екстремальна жадібність / Сильний попит',
  };
  const sentimentLabel = sentimentLabels[sentimentState];

  const nearHighsPct = locationCount > 0 ? Math.round(nearHighCount / locationCount * 100) : 0;
  const nearLowsPct = locationCount > 0 ? Math.round(nearLowCount / locationCount * 100) : 0;
  const breadthScore = Math.round(clamp(50 + directionStrength * 50, 0, 100));
  const breadthVerdict = breadthScore >= 65
    ? 'Переважає зростання цін серед торгових пар'
    : breadthScore <= 35
      ? 'Переважає падіння цін серед торгових пар'
      : 'Збалансований або малорухомий ринок';
  const volatilityIndex = Math.round(clamp(avgVolatility * 9, 0, 100));
  const volLabel = volatilityIndex > 75
    ? 'Висока добова волатильність'
    : volatilityIndex > 45 ? 'Помірна добова волатильність' : 'Низька добова волатильність';

  const sources = isLiveRequest ? getMarketSourceStatuses({ exchange: 'all', marketType: 'all' }) : [];
  const freshSources = sources.filter(s => s.status === 'live').length;
  const availableSources = sources.filter(s => s.status !== 'unavailable').length;
  const latestSourceTime = Math.max(0, ...sources.map(s => s.updatedAt ?? 0));
  const updatedAt = latestSourceTime > 0 ? latestSourceTime : now;

  const summary = `Настрій ринку: ${sentimentLabel} (${compositeScore}/100). ` +
    `Зростають ${advancingCount} із ${total} пар (${advancingPct}%), падають ${decliningCount}; ` +
    `середня зміна ціни за 24 год: ${avgChange24h >= 0 ? '+' : ''}${avgChange24h}%. ` +
    `Середній добовий діапазон: ${avgVolatility}%. ` +
    'Індекс є орієнтовною оцінкою цінової динаміки, не вимірюванням грошових потоків.';

  const data: MarketSentimentData = {
    compositeScore,
    sentimentState,
    sentimentLabel,
    summary,
    priceTrendDynamics: {
      advancingCount,
      decliningCount,
      advancingPct,
      trendBias,
      avgChange24h,
    },
    tradingVolume: {
      total24hUsd: totalVolume24h,
      // A single 24h snapshot does not provide volume velocity or its change.
      volumeVelocity: null,
      volumeChangePct: null,
    },
    marketVolatility: {
      index: volatilityIndex,
      label: volLabel,
      avgDailyRangePct: avgVolatility,
    },
    marketBreadth: {
      // EMA20 requires actual historical closing prices per instrument.
      aboveEma20Pct: null,
      nearHighsPct,
      nearLowsPct,
      breadthScore,
      verdict: breadthVerdict,
    },
    capitalFlow: {
      // Turnover times price change is NOT a net capital inflow.
      netInflow24hUsd: null,
      direction: null,
      label: 'Дані про фактичні потоки капіталу недоступні',
    },
    derivativesOverview: {
      // Never infer open interest or funding from turnover.
      aggregatedOIUsd: null,
      oiChange24hPct: null,
      avgFundingRate: null,
      fundingBias: null,
    },
    dataQuality: {
      analyzedPairs: total,
      locationCoveragePct: Math.round(locationCoverage * 100),
      freshSources,
      availableSources,
      totalSources: sources.length,
    },
    lastUpdated: updatedAt,
  };

  // Synthetic/provided samples must not poison the shared live cache.
  if (isLiveRequest) sentimentCache = { timestamp: Date.now(), data };
  return data;
}
