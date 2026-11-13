import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import type { ExchangeId, HookChartPreferences, MarketType } from '../../types';
import { adaptiveCut, atr, quantile, type MarketPrint } from './marketAnalytics';
import { getSharedMarketPrints, subscribeMarketTrades } from './marketTradeStream';
import { calcCascadeRisk, type Candle, type Density, type Liquidation } from './engine';
import { normalizeExchangeSymbol } from '../../utils/marketSymbols';
import type { ChartDepthStatus } from '../../utils/hookChartDepthProtocol';
import { connectHookChartDepth } from './depthStream';
import { connectHookChartLiquidations } from './liquidationStream';
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
    const clearDepth = () => {
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
    applyBookRef.current = applyBook;
    clearDepth();
    const stopDepth = connectHookChartDepth({
      exchange, marketType, symbol,
      onBook: update => {
        if (dead || !depthBook.apply(update)) return false;
        return applyBook();
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
    const publish = () => {
      if (dead) return;
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
      setLiquidations([...raw]);
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
      setLiquidationLastEventAt(current => Math.max(current || 0, row.t));
      publish();
    };

    setLiquidations([]);
    setLiquidationCut(0);
    setLiquidationLastEventAt(null);
    const stop = connectHookChartLiquidations({
      exchange, symbol,
      onSnapshot: (events, connected) => {
        if (dead) return;
        raw = deduplicateLiquidations(events);
        // Recover session-era events from a reconnect snapshot, without counting
        // pre-session historical events or repeating IDs already received.
        for (const row of events) recordSessionLiquidation(liquidationScope, row, 'snapshot');
        setLiquidationLastEventAt(raw.length ? Math.max(...raw.map(row => row.t)) : null);
        setLiquidationStreamLive(connected);
        publish();
      },
      onLiquidation: push,
      onStatus: connected => { if (!dead) setLiquidationStreamLive(connected); },
    });
    const publishTimer = setInterval(publish, 2000);
    return () => {
      dead = true;
      clearInterval(publishTimer);
      stop();
    };
  }, [exchange, marketType, symbol, replay]);

  useEffect(() => {
    const exchangeSymbol = /^[\p{L}\p{M}\p{N}]+$/u.test(symbol);
    if (replay || !exchangeSymbol || marketType !== 'futures') {
      setFundingRate(Number.NaN);
      setFundingHistory([]);
      return;
    }
    let dead = false;
    let controller = new AbortController();
    let lastHistoryFetchAt = 0;
    let nextFundingAt = 0;
    setFundingRate(Number.NaN); setFundingHistory([]);

    const pull = async () => {
      try {
        if (exchange === 'binance') {
          // Current rate still refreshes every minute. Historical funding only
          // changes at settlement, so don't download 100 rows every minute.
          const refreshHistory = Date.now() - lastHistoryFetchAt >= 15 * 60_000 ||
            (nextFundingAt > 0 && Date.now() >= nextFundingAt);
          const [premiumResponse, historyResponse] = await Promise.all([
            fetch(`${BINANCE_FUTURES_API}/fapi/v1/premiumIndex?symbol=${encodeURIComponent(symbol)}`, { signal: controller.signal, cache: 'no-store' }),
            refreshHistory
              ? fetch(`${BINANCE_FUTURES_API}/fapi/v1/fundingRate?symbol=${encodeURIComponent(symbol)}&limit=100`, { signal: controller.signal, cache: 'no-store' })
              : Promise.resolve(null),
          ]);
          if (!premiumResponse.ok || (historyResponse && !historyResponse.ok)) {
            if (!dead) setFundingRate(Number.NaN);
            return;
          }
          const premium = await premiumResponse.json();
          const history = historyResponse ? await historyResponse.json() : null;
          if (dead) return;
          const futureFundingAt = Number(premium?.nextFundingTime);
          if (Number.isFinite(futureFundingAt) && futureFundingAt > Date.now())
            nextFundingAt = futureFundingAt;
          setFundingRate(premium?.lastFundingRate == null ? Number.NaN : Number(premium.lastFundingRate));
          if (historyResponse) {
            setFundingHistory((Array.isArray(history) ? history : []).map((row: any) => Number(row.fundingRate)).filter(Number.isFinite));
            lastHistoryFetchAt = Date.now();
          }
        } else {
          const refreshHistory = Date.now() - lastHistoryFetchAt >= 15 * 60_000 ||
            (nextFundingAt > 0 && Date.now() >= nextFundingAt);
          const [tickerResponse, historyResponse] = await Promise.all([
            fetch(`${BYBIT_API}/v5/market/tickers?category=linear&symbol=${encodeURIComponent(symbol)}`, { signal: controller.signal, cache: 'no-store' }),
            refreshHistory
              ? fetch(`${BYBIT_API}/v5/market/funding/history?category=linear&symbol=${encodeURIComponent(symbol)}&limit=100`, { signal: controller.signal, cache: 'no-store' })
              : Promise.resolve(null),
          ]);
          if (!tickerResponse.ok || (historyResponse && !historyResponse.ok)) {
            if (!dead) setFundingRate(Number.NaN);
            return;
          }
          const ticker = await tickerResponse.json();
          const history = historyResponse ? await historyResponse.json() : null;
          if (dead) return;
          const value = ticker?.result?.list?.[0]?.fundingRate;
          const futureFundingAt = Number(ticker?.result?.list?.[0]?.nextFundingTime);
          if (Number.isFinite(futureFundingAt) && futureFundingAt > Date.now())
            nextFundingAt = futureFundingAt;
          setFundingRate(ticker?.retCode === 0 && value != null ? Number(value) : Number.NaN);
          if (historyResponse) {
            setFundingHistory((history?.result?.list || []).map((row: any) => Number(row.fundingRate)).filter(Number.isFinite));
            lastHistoryFetchAt = Date.now();
          }
        }
      } catch { if (!dead) { setFundingRate(Number.NaN); setFundingHistory([]); } }
    };

    void pull();
    const timer = setInterval(() => {
      controller.abort();
      controller = new AbortController();
      void pull();
    }, 60_000);

    return () => {
      dead = true;
      controller.abort();
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
