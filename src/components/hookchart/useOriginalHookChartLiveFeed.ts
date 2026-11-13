import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import type { ExchangeId, HookChartPreferences, MarketType } from '../../types';
import { adaptiveCut, atr, quantile, type MarketPrint } from './marketAnalytics';
import { getSharedMarketPrints, subscribeMarketTrades } from './marketTradeStream';
import { fetchSharedChartJson } from '../../utils/sharedChartRequests';
import { calcCascadeRisk, type Candle, type Density, type Liquidation } from './engine';
import { normalizeExchangeSymbol } from '../../utils/marketSymbols';
import type { ChartDepthStatus } from '../../utils/hookChartDepthProtocol';
import { connectSharedHookChartDepth } from './sharedDepthStream';
import { connectSharedHookChartLiquidations } from './sharedLiquidationStream';
import { HookChartDensityBook, type DensityAutoStats } from './densityBook';
import { EMPTY_SESSION_LIQUIDATIONS, getSessionLiquidationTotals, recordSessionLiquidation, sessionLiquidationScope, subscribeSessionLiquidations } from './liquidationSession';
import { canonicalLiquidationId, deduplicateLiquidations, filterVisibleLiquidations } from './liquidationDisplay';

type BookLevel = { p: number; q: number };

type LiveFeedArgs = {
  exchange: ExchangeId;
  marketType: MarketType;
  symbol: string;
  settings: HookChartPreferences;
  candles: Candle[];
  replay?: boolean;
};

const BINANCE_FUTURES_API = 'https://fapi.binance.com';
const BYBIT_API = 'https://api.bybit.com';

export function useOriginalHookChartLiveFeed({
  exchange,
  marketType,
  symbol: rawSymbol,
  settings,
  candles,
  replay = false,
}: LiveFeedArgs) {
  const symbol = normalizeExchangeSymbol(rawSymbol);
  // Key deliberately excludes candle timeframe and display threshold.
  const liquidationScope = sessionLiquidationScope(exchange, marketType, symbol);
  const sessionSubscription = useMemo(() => ({
    subscribe: (notify: () => void) => subscribeSessionLiquidations(liquidationScope, notify),
    snapshot: () => getSessionLiquidationTotals(liquidationScope),
  }), [liquidationScope]);
  const sessionTotals = useSyncExternalStore(sessionSubscription.subscribe, sessionSubscription.snapshot, () => EMPTY_SESSION_LIQUIDATIONS);
  const [densities, setDensities] = useState<Density[]>([]);
  const [marketPrints, setMarketPrints] = useState<MarketPrint[]>([]);
  const [liquidations, setLiquidations] = useState<Liquidation[]>([]);
  const [liquidationCut, setLiquidationCut] = useState(0);
  const [liquidationStreamLive, setLiquidationStreamLive] = useState(false);
  const [liquidationLastEventAt, setLiquidationLastEventAt] = useState<number | null>(null);
  const [densityCut, setDensityCut] = useState(0);
  const [densityAutoStats, setDensityAutoStats] = useState<DensityAutoStats>({
    baseline: 0, bidCut: 0, askCut: 0, buy5m: 0, sell5m: 0,
  });
  const [book, setBook] = useState<{ b: BookLevel[]; a: BookLevel[] }>({ b: [], a: [] });
  const [fundingRate, setFundingRate] = useState(Number.NaN);
  const [fundingHistory, setFundingHistory] = useState<number[]>([]);
  const [depthReady, setDepthReady] = useState(false);
  const [depthStatus, setDepthStatus] = useState<ChartDepthStatus>('connecting');
  const depthScopeRef = useRef('');
  const depthScope = `${exchange}:${marketType}:${symbol}:${replay}`;
  const priceRef = useRef(0);
  const atrRef = useRef(0);
  const settingsRef = useRef(settings);
  settingsRef.current = settings;
  const applyBookRef = useRef<(() => void) | null>(null);

  useEffect(() => {
    const last = candles.at(-1);
    if (last?.c) priceRef.current = last.c;
    atrRef.current = atr(candles, 50);
  }, [candles]);

  useEffect(() => {
    const exchangeSymbol = /^[\p{L}\p{M}\p{N}]+$/u.test(symbol);
    if (replay || !exchangeSymbol) {
      depthScopeRef.current = '';
      setDepthStatus(replay ? 'disabled' : 'unavailable');
      setDensities([]);
      setMarketPrints([]);
      setBook({ b: [], a: [] });
      setDepthReady(false);
      setDensityCut(0);
      setDensityAutoStats({ baseline: 0, bidCut: 0, askCut: 0, buy5m: 0, sell5m: 0 });
      return;
    }

    let dead = false;
    const depthBook = new HookChartDensityBook();
    let depthPublishTimer: ReturnType<typeof setTimeout> | null = null;
    let lastDepthPublishAt = 0;
    const clearDepth = () => {
      if (depthPublishTimer !== null) {
        clearTimeout(depthPublishTimer);
        depthPublishTimer = null;
      }
      depthScopeRef.current = '';
      depthBook.clear();
      setDepthReady(false);
      setDensities([]);
      setBook({ b: [], a: [] });
      setDensityCut(0);
      setDensityAutoStats({ baseline: 0, bidCut: 0, askCut: 0, buy5m: 0, sell5m: 0 });
    };
    const applyBook = () => {
      if (dead) return false;
      const next = depthBook.read(settingsRef.current, atrRef.current);
      depthScopeRef.current = next.depthReady ? depthScope : '';
      if (next.price) priceRef.current = next.price;
      setDensities(next.densities);
      setBook(next.book);
      setDensityCut(next.densityCut);
      setDensityAutoStats(next.autoStats);
      setDepthReady(next.depthReady);
      if (!next.depthReady) setDepthStatus(current => current === 'live' ? 'reconnecting' : current);
      return next.depthReady;
    };
    // Apply every depth delta to each chart's exact local order book, but
    // throttle only expensive derived-density rendering (at most 5 per second).
    // Never throttle or drop a deletion/sequence update itself.
    const queueDepthPublish = () => {
      if (depthPublishTimer !== null || dead) return;
      const remaining = 200 - (Date.now() - lastDepthPublishAt);
      if (remaining <= 0) {
        lastDepthPublishAt = Date.now();
        applyBook();
      } else {
        depthPublishTimer = setTimeout(() => {
          depthPublishTimer = null;
          if (!dead) {
            lastDepthPublishAt = Date.now();
            applyBook();
          }
        }, remaining);
      }
    };
    applyBookRef.current = applyBook;
    clearDepth();
    const stopDepth = connectSharedHookChartDepth({
      exchange, marketType, symbol,
      onBook: update => {
        if (dead || !depthBook.apply(update)) return false;
        queueDepthPublish();
        return true;
      },
      onStatus: status => {
        if (dead) return;
        setDepthStatus(status);
        if (status !== 'live') clearDepth();
      },
    });
    // Advance holding time even if the next exchange event contains no price change.
    const depthPublish = setInterval(applyBook, 1000);

    // All charts of the same exchange/market/symbol share one REST seed,
    // WebSocket and adaptive threshold. Each chart still gets trade evidence
    // for its own depth/absorption analysis.
    setMarketPrints([]);
    const stopTrades = subscribeMarketTrades(
      { exchange, marketType, symbol },
      {
        onTrade: trade => {
          if (!dead) depthBook.recordAggressiveTrade(trade);
        },
        onPrints: prints => {
          if (!dead && settingsRef.current.showMarketPrintSums === true)
            setMarketPrints(prints);
        },
        wantsPrints: () => settingsRef.current.showMarketPrintSums === true,
      },
    );

    return () => {
      dead = true;
      if (applyBookRef.current === applyBook) applyBookRef.current = null;
      stopTrades();
      stopDepth();
      clearInterval(depthPublish);
      if (depthPublishTimer !== null) clearTimeout(depthPublishTimer);
      depthBook.clear();
    };
  }, [
    exchange, marketType, symbol, replay,
  ]);

  // The drawing toggle does not reopen the exchange connection. Hide print
  // updates entirely while disabled, but restore the shared snapshot on enable.
  useEffect(() => {
    setMarketPrints(settings.showMarketPrintSums === true && !replay
      ? getSharedMarketPrints({ exchange, marketType, symbol }) : []);
  }, [settings.showMarketPrintSums, exchange, marketType, symbol, replay]);

  useEffect(() => {
    applyBookRef.current?.();
  }, [settings.densityAnalysis, settings.densityDiffPct, settings.densityAutoMultiplier,
    settings.densityMode, settings.densityThreshold, settings.densityTimeoutMin]);

  useEffect(() => {
    const exchangeSymbol = /^[\p{L}\p{M}\p{N}]+$/u.test(symbol);
    if (replay || !exchangeSymbol || marketType !== 'futures') {
      setLiquidations([]);
      setLiquidationCut(0);
      setLiquidationStreamLive(false);
      setLiquidationLastEventAt(null);
      return;
    }

    let dead = false;
    let raw: Liquidation[] = [];
    let latestEventAt = 0;
    let pendingLiquidationPublish: ReturnType<typeof setTimeout> | null = null;
    const publish = () => {
      if (dead) return;
      if (pendingLiquidationPublish !== null) {
        clearTimeout(pendingLiquidationPublish);
        pendingLiquidationPublish = null;
      }
      const now = Date.now();
      raw.sort((a, b) => a.t - b.t);
      while (raw.length && now - raw[0].t > 30 * 60_000) raw.shift();
      if (raw.length > 1500) raw.splice(0, raw.length - 1500);
      const values = raw.filter(row => now - row.t <= 15 * 60_000)
        .map(row => row.usd).filter(value => Number.isFinite(value) && value > 0);
      const adaptive = !values.length ? 0 : values.length < 6
        ? quantile(values, .75)
        : Math.max(quantile(values, .8), adaptiveCut(values, .8, .98, 2.5));
      setLiquidationCut(values.length ? Math.max(1000, adaptive) : 0);
      setLiquidationLastEventAt(latestEventAt || null);
      setLiquidations([...raw]);
    };
    const scheduleLiquidationPublish = () => {
      if (dead || pendingLiquidationPublish !== null) return;
      pendingLiquidationPublish = setTimeout(() => {
        pendingLiquidationPublish = null;
        publish();
      }, 200);
    };
    const push = (row: Liquidation) => {
      if (dead || !Number.isFinite(row.usd) || row.usd <= 0) return;
      recordSessionLiquidation(liquidationScope, row);
      const id = canonicalLiquidationId(row.id);
      const index = raw.findIndex(item => item.id === id);
      if (index >= 0) {
        if (row.usd <= raw[index].usd) return; // replayed event or older fill
        raw[index] = { ...row, id };
      } else raw.push({ ...row, id });
      latestEventAt = Math.max(latestEventAt, row.t);
      // Preserve every event and the immediate session counter update; only
      // group React renders while bursts arrive at high frequency.
      scheduleLiquidationPublish();
    };

    setLiquidations([]);
    setLiquidationCut(0);
    setLiquidationLastEventAt(null);
    const stop = connectSharedHookChartLiquidations({
      exchange, symbol,
      onSnapshot: (events, connected) => {
        if (dead) return;
        raw = deduplicateLiquidations(events);
        // Recover session-era events from a reconnect snapshot, without counting
        // pre-session historical events or repeating IDs already received.
        for (const row of events) recordSessionLiquidation(liquidationScope, row, 'snapshot');
        latestEventAt = raw.length ? Math.max(...raw.map(row => row.t)) : 0;
        setLiquidationStreamLive(connected);
        publish();
      },
      onLiquidation: push,
      onStatus: connected => { if (!dead) setLiquidationStreamLive(connected); },
    });
    const publishTimer = setInterval(publish, 2000);
    return () => {
      dead = true;
      if (pendingLiquidationPublish !== null) clearTimeout(pendingLiquidationPublish);
      clearInterval(publishTimer);
      stop();
    };
  }, [exchange, marketType, symbol, replay]);

  useEffect(() => {
    const exchangeSymbol = /^[\\p{L}\\p{M}\\p{N}]+$/u.test(symbol);
    if (replay || !exchangeSymbol || marketType !== 'futures') {
      setFundingRate(Number.NaN);
      setFundingHistory([]);
      return;
    }
    let dead = false;
    let pulling = false;
    let lastHistoryFetchAt = 0;
    let nextFundingAt = 0;
    setFundingRate(Number.NaN);
    setFundingHistory([]);

    const pull = async () => {
      if (dead || pulling) return;
      pulling = true;
      try {
        const refreshHistory = Date.now() - lastHistoryFetchAt >= 15 * 60_000 ||
          (nextFundingAt > 0 && Date.now() >= nextFundingAt);
        if (exchange === 'binance') {
          const [premium, history] = await Promise.all([
            fetchSharedChartJson(`${BINANCE_FUTURES_API}/fapi/v1/premiumIndex?symbol=${encodeURIComponent(symbol)}`),
            refreshHistory
              ? fetchSharedChartJson(`${BINANCE_FUTURES_API}/fapi/v1/fundingRate?symbol=${encodeURIComponent(symbol)}&limit=100`, 'funding-history')
              : Promise.resolve(null),
          ]);
          if (dead) return;
          const futureFundingAt = Number(premium?.nextFundingTime);
          if (Number.isFinite(futureFundingAt) && futureFundingAt > Date.now())
            nextFundingAt = futureFundingAt;
          setFundingRate(premium?.lastFundingRate == null ? Number.NaN : Number(premium.lastFundingRate));
          if (refreshHistory) {
            setFundingHistory((Array.isArray(history) ? history : [])
              .map((row: any) => Number(row.fundingRate)).filter(Number.isFinite));
            lastHistoryFetchAt = Date.now();
          }
        } else {
          const [ticker, history] = await Promise.all([
            fetchSharedChartJson(`${BYBIT_API}/v5/market/tickers?category=linear&symbol=${encodeURIComponent(symbol)}`),
            refreshHistory
              ? fetchSharedChartJson(`${BYBIT_API}/v5/market/funding/history?category=linear&symbol=${encodeURIComponent(symbol)}&limit=100`, 'funding-history')
              : Promise.resolve(null),
          ]);
          if (dead) return;
          const value = ticker?.result?.list?.[0]?.fundingRate;
          const futureFundingAt = Number(ticker?.result?.list?.[0]?.nextFundingTime);
          if (Number.isFinite(futureFundingAt) && futureFundingAt > Date.now())
            nextFundingAt = futureFundingAt;
          setFundingRate(ticker?.retCode === 0 && value != null ? Number(value) : Number.NaN);
          if (refreshHistory) {
            setFundingHistory((history?.result?.list || [])
              .map((row: any) => Number(row.fundingRate)).filter(Number.isFinite));
            lastHistoryFetchAt = Date.now();
          }
        }
      } catch {
        if (!dead) { setFundingRate(Number.NaN); setFundingHistory([]); }
      } finally {
        pulling = false;
      }
    };
    void pull();
    const timer = setInterval(() => void pull(), 60_000);
    return () => {
      dead = true;
      clearInterval(timer);
    };
  }, [exchange, marketType, symbol, replay]);

  // Display thresholds never mutate the incoming events or the session totals.
  const visibleLiquidations = useMemo(() => filterVisibleLiquidations(liquidations, liquidationCut, settings),
    [liquidations, liquidationCut, settings.showLiquidationLong,
      settings.showLiquidationShort, settings.liquidationLongMinUsd, settings.liquidationShortMinUsd]);
  const risk = useMemo(
    () => calcCascadeRisk(liquidations, liquidationCut, candles.at(-1)?.c || 0),
    [liquidations, liquidationCut, candles.at(-1)?.c],
  );
  const liquidationSource = marketType === 'futures'
    ? (exchange === 'binance' ? 'BIN forceOrder' : 'BYB allLiq')
    : '';

  const currentDepth = depthScopeRef.current === depthScope && depthReady;
  return {
    densities: currentDepth ? densities : [],
    marketPrints,
    liquidations: visibleLiquidations,
    allLiquidations: liquidations,
    sessionLiquidationsUsd: sessionTotals.totalUsd,
    sessionLiquidationsLongUsd: sessionTotals.longUsd,
    sessionLiquidationsShortUsd: sessionTotals.shortUsd,
    liquidationCut,
    liquidationStreamLive,
    liquidationLastEventAt,
    liquidationSource,
    cascadeRisk: risk,
    densityCut: currentDepth ? densityCut : 0,
    densityAutoStats: currentDepth ? densityAutoStats : { baseline: 0, bidCut: 0, askCut: 0, buy5m: 0, sell5m: 0 },
    book: currentDepth ? book : { b: [], a: [] },
    fundingRate,
    fundingHistory,
    depthReady: currentDepth,
    depthStatus,
  };
}
