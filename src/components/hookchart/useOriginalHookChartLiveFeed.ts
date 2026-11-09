import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import type { ExchangeId, HookChartPreferences, MarketType } from '../../types';
import { adaptiveCut, atr, quantile, type MarketPrint } from './marketAnalytics';
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
const BINANCE_SPOT_APIS = ['https://data-api.binance.vision', 'https://api.binance.com'];
const BINANCE_FUTURES_WS = 'wss://fstream.binance.com/market/ws';
const BINANCE_SPOT_WS = 'wss://stream.binance.com:9443/ws';
const BYBIT_API = 'https://api.bybit.com';
const BYBIT_WS = {
  futures: 'wss://stream.bybit.com/v5/public/linear',
  spot: 'wss://stream.bybit.com/v5/public/spot',
} as const;

async function fetchBinanceJson(path: string, marketType: MarketType, signal?: AbortSignal) {
  const hosts = marketType === 'futures' ? [BINANCE_FUTURES_API] : BINANCE_SPOT_APIS;
  let lastError: unknown;
  for (const host of hosts) {
    try {
      const response = await fetch(`${host}${path}`, { signal, cache: 'no-store' });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      return await response.json();
    } catch (error) {
      lastError = error;
      if (signal?.aborted) throw error;
    }
  }
  throw lastError instanceof Error ? lastError : new Error('Binance unavailable');
}

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
    let tradeSocket: WebSocket | null = null;
    let tradePing: ReturnType<typeof setInterval> | null = null;
    const depthBook = new HookChartDensityBook();
    const tradeWindow: Array<{ t: number; usd: number }> = [];
    let lastTradeThresholdCalc = 0;
    let tradeCut = 0;
    let burst: { side: 'BUY' | 'SELL'; start: number; last: number; usd: number; pv: number; count: number; id: string } | null = null;

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

    type Trade = { t: number; p: number; q: number; side: 'BUY' | 'SELL'; id: string };

    const commitBurst = () => {
      if (dead || !burst || !tradeCut || burst.usd < tradeCut) return;
      const p = burst.pv / Math.max(1, burst.usd);
      const score = Math.min(100, Math.round(100 * burst.usd / Math.max(tradeCut * 2, 1)));
      const item: MarketPrint = {
        id: burst.id, side: burst.side, t: burst.start, p, usd: burst.usd,
        count: burst.count, touches: 1, lastTouch: burst.start, score,
      };
      setMarketPrints(previous => {
        const next = [...previous];
        const index = next.findIndex(row => row.id === item.id);
        if (index >= 0) next[index] = item;
        else next.push(item);
        return next.filter(row => Date.now() - row.t < 6 * 60 * 60_000).slice(-60);
      });
    };

    const handleTrade = (trade: Trade) => {
      if (dead || !Number.isFinite(trade.p) || !Number.isFinite(trade.q) || trade.p <= 0 || trade.q <= 0) return;
      const usd = trade.p * trade.q;
      depthBook.recordAggressiveTrade({ t: trade.t, p: trade.p, usd, side: trade.side, id: trade.id });
      tradeWindow.push({ t: trade.t, usd });
      while (tradeWindow.length && trade.t - tradeWindow[0].t > 120_000) tradeWindow.shift();
      if (!tradeCut || trade.t - lastTradeThresholdCalc > 3000) {
        tradeCut = adaptiveCut(tradeWindow.map(row => row.usd), .95, .995, 2.8);
        lastTradeThresholdCalc = trade.t;
      }
      if (!burst || burst.side !== trade.side || trade.t - burst.last > 450 || trade.t - burst.start > 1400) {
        commitBurst();
        burst = { side: trade.side, start: trade.t, last: trade.t, usd, pv: trade.p * usd, count: 1, id: `${trade.side}:${trade.t}:${trade.id}` };
      } else {
        burst.last = trade.t;
        burst.usd += usd;
        burst.pv += trade.p * usd;
        burst.count += 1;
      }
      if (tradeCut && burst.usd >= tradeCut) commitBurst();
    };

    const seedTrades = async () => {
      try {
        let rows: Trade[] = [];
        if (exchange === 'binance') {
          const path = marketType === 'futures'
            ? `/fapi/v1/aggTrades?symbol=${encodeURIComponent(symbol)}&limit=1000`
            : `/api/v3/aggTrades?symbol=${encodeURIComponent(symbol)}&limit=1000`;
          const data = await fetchBinanceJson(path, marketType);
          rows = (Array.isArray(data) ? data : []).map((row: any) => ({
            t: Number(row.T) || Date.now(),
            p: Number(row.p),
            q: Number(row.q),
            side: row.m ? 'SELL' : 'BUY',
            id: String(row.a ?? row.T),
          }));
        } else {
          const category = marketType === 'futures' ? 'linear' : 'spot';
          const response = await fetch(`${BYBIT_API}/v5/market/recent-trade?category=${category}&symbol=${encodeURIComponent(symbol)}&limit=1000`, { cache: 'no-store' });
          if (!response.ok) return;
          const data = await response.json();
          rows = (data?.result?.list || []).map((row: any) => ({
            t: Number(row.time) || Date.now(),
            p: Number(row.price),
            q: Number(row.size),
            side: String(row.side).toLowerCase() === 'sell' ? 'SELL' : 'BUY',
            id: String(row.execId || row.time),
          })).sort((a: Trade, b: Trade) => a.t - b.t);
        }
        if (dead || !rows.length) return;
        tradeCut = adaptiveCut(rows.map(row => row.p * row.q), .95, .995, 2.8);
        lastTradeThresholdCalc = Date.now();
        for (const row of rows) handleTrade(row);
        commitBurst();
      } catch {}
    };
    void seedTrades();

    try {
      if (exchange === 'binance') {
        const host = marketType === 'futures' ? BINANCE_FUTURES_WS : BINANCE_SPOT_WS;
        tradeSocket = new WebSocket(`${host}/${encodeURIComponent(symbol.toLowerCase())}@aggTrade`);
        tradeSocket.onmessage = event => {
          if (dead) return;
          try {
            const row = JSON.parse(event.data);
            handleTrade({
              t: Number(row.T) || Date.now(), p: Number(row.p), q: Number(row.q),
              side: row.m ? 'SELL' : 'BUY', id: String(row.a ?? row.T),
            });
          } catch {}
        };
      } else {
        tradeSocket = new WebSocket(BYBIT_WS[marketType]);
        tradeSocket.onopen = () => tradeSocket?.send(JSON.stringify({ op: 'subscribe', args: [`publicTrade.${symbol}`] }));
        tradeSocket.onmessage = event => {
          if (dead) return;
          try {
            const message = JSON.parse(event.data);
            if (message.topic !== `publicTrade.${symbol}` || !Array.isArray(message.data)) return;
            for (const row of message.data) {
              handleTrade({
                t: Number(row.T) || Date.now(), p: Number(row.p), q: Number(row.v),
                side: String(row.S).toLowerCase() === 'sell' ? 'SELL' : 'BUY',
                id: String(row.i || row.T),
              });
            }
          } catch {}
        };
        tradePing = setInterval(() => {
          if (tradeSocket?.readyState === WebSocket.OPEN) try { tradeSocket.send(JSON.stringify({ op: 'ping' })); } catch {}
        }, 20_000);
      }
    } catch {}

    return () => {
      dead = true;
      if (applyBookRef.current === applyBook) applyBookRef.current = null;
      stopDepth();
      clearInterval(depthPublish);
      depthBook.clear();
      if (tradePing) clearInterval(tradePing);
      try { tradeSocket?.close(); } catch {}
    };
  }, [
    exchange, marketType, symbol, replay,
  ]);

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
    marketPrints: marketPrints.slice(-40),
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
