import React, { useState, useEffect, useRef } from 'react';
import {
  Sparkles,
  TrendingUp,
  TrendingDown,
  ShieldAlert,
  Target,
  Activity,
  Layers,
  BarChart3,
  Calendar,
  AlertTriangle,
  CheckCircle2,
  DollarSign,
  Clock,
  RefreshCw,
  ChevronUp,
  Gauge,
  Sliders,
  Radio,
  Eye,
  Crosshair,
  Zap,
  Info,
  Wallet,
  Users,
  Fingerprint,
  Lock,
  ShieldCheck,
} from 'lucide-react';
import { SmartAnalysisData, ScannedCoin, DetectedFormation, Kline, Timeframe } from '../types';
import { formatCryptoPrice, formatVolume, formatPercent } from '../utils/formatters';

interface SmartAnalysisBlockProps {
  coin: ScannedCoin;
  formation?: DetectedFormation | null;
  klines?: Kline[];
  timeframe?: Timeframe;
  /** Canonical detected-formation setup and its Telegram actions from detail view. */
  tradeSetup?: React.ReactNode;
  /** Close the panel without changing the analysis refresh behavior. */
  onCollapse?: () => void;
}

export const SmartAnalysisBlock: React.FC<SmartAnalysisBlockProps> = ({
  coin,
  formation,
  klines,
  timeframe,
  tradeSetup,
  onCollapse,
}) => {
  const [data, setData] = useState<SmartAnalysisData | null>(null);
  const [loading, setLoading] = useState<boolean>(true);
  const [error, setError] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState<'all' | 'btc' | 'tech' | 'orderbook' | 'derivatives' | 'institutional'>('all');
  const analysisAbortRef = useRef<AbortController | null>(null);

  const fetchAnalysis = async () => {
    analysisAbortRef.current?.abort();
    const controller = new AbortController();
    analysisAbortRef.current = controller;
    setLoading(true);
    setError(null);
    // Old ATR/market data must not be shown under another coin/timeframe.
    setData(null);
    try {
      const queryParams = new URLSearchParams({
        symbol: coin.symbol,
        exchange: coin.exchange,
        marketType: coin.marketType,
        timeframe: timeframe || coin.timeframe || '1h',
        price: String(coin.currentPrice),
      });

      const res = await fetch(`/api/market/smart-analysis?${queryParams.toString()}`, {
        signal: controller.signal,
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = await res.json();
      if (controller.signal.aborted) return;
      if (json.success && json.data) {
        setData(json.data);
      } else {
        throw new Error(json.error || 'Failed to parse smart analysis');
      }
    } catch (err: any) {
      if (controller.signal.aborted) return;
      console.error('Smart analysis error:', err);
      setError(err.message || 'Не вдалося завантажити розумний аналіз');
    } finally {
      if (!controller.signal.aborted) setLoading(false);
    }
  };

  useEffect(() => {
    void fetchAnalysis();
    return () => analysisAbortRef.current?.abort();
  }, [coin.symbol, coin.exchange, coin.marketType, coin.timeframe, timeframe]);

  const collapseControl = onCollapse ? (
    <button
      type="button"
      onClick={onCollapse}
      aria-expanded={true}
      aria-label="Згорнути Розумний аналіз AI + Quant"
      title="Згорнути Розумний аналіз"
      className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-lg border border-indigo-500/40 bg-slate-900 text-slate-300 transition-colors hover:text-indigo-300 focus-visible:outline focus-visible:outline-2 focus-visible:outline-indigo-400"
    >
      <ChevronUp className="h-4 w-4" />
    </button>
  ) : null;

  if (loading && !data) {
    return (
      <>
      {tradeSetup}
      <div className="p-6 rounded-2xl bg-gradient-to-b from-slate-900 to-slate-950 border border-indigo-900/40 text-center space-y-3 animate-pulse">
        {onCollapse && <div className="mb-1 flex justify-end">{collapseControl}</div>}
        <div className="flex items-center justify-center gap-2 text-indigo-400">
          <Sparkles className="w-5 h-5 animate-spin" />
          <span className="text-sm font-bold uppercase tracking-wider">Генерація Розумного Аналізу...</span>
        </div>
        <p className="text-xs text-slate-400 max-w-md mx-auto">
          Аналізуємо мультитаймфреймовий BTC (15m → 5m → 1m), стакан ордерів, зону POC, інституційний Open Interest та ATR волатильність. Entry, SL і TP беруться з виявленої формації.
        </p>
      </div>
      </>
    );
  }

  if (error && !data) {
    return (
      <>
      {tradeSetup}
      <div className="p-4 rounded-xl bg-rose-950/20 border border-rose-800/40 flex flex-wrap items-center justify-between gap-3 text-xs text-rose-300">
        <div className="flex items-center gap-2">
          <AlertTriangle className="w-4 h-4 text-rose-400 shrink-0" />
          <span>{error}</span>
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={fetchAnalysis}
            className="px-2.5 py-1 rounded bg-rose-900/40 hover:bg-rose-900/60 text-white font-medium flex items-center gap-1 cursor-pointer"
          >
            <RefreshCw className="w-3 h-3" />
            Спробувати знову
          </button>
          {collapseControl}
        </div>
      </div>
      </>
    );
  }

  if (!data) return <>{tradeSetup}</>;

  return (
    <div className="p-4 sm:p-6 rounded-2xl bg-gradient-to-b from-slate-900 via-slate-900/90 to-slate-950 border border-indigo-500/30 shadow-xl shadow-indigo-950/20 space-y-5">
      {/* Header controls have their own grid column: no absolute overlay over the title on mobile. */}
      <div className="grid grid-cols-[auto_minmax(0,1fr)_auto] items-start gap-x-2.5 gap-y-1 pb-3 border-b border-slate-800">
        <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-xl border border-indigo-500/40 bg-indigo-500/20 text-indigo-400">
          <Zap className="h-4 w-4 fill-current" />
        </div>
        <div className="flex min-w-0 flex-wrap items-center gap-1.5">
          <h4 className="min-w-0 text-[13px] sm:text-base font-bold text-white uppercase tracking-wider">
            РОЗУМНИЙ АНАЛІЗ
          </h4>
          <span className="shrink-0 px-2 py-0.5 rounded-full text-[10px] font-bold bg-indigo-500/20 border border-indigo-500/40 text-indigo-300 font-mono">
            AI + Quant
          </span>
        </div>
        <div className="flex shrink-0 items-center gap-1.5">
          <button
            type="button"
            onClick={fetchAnalysis}
            disabled={loading}
            aria-label="Оновити розрахунок"
            title="Оновити розрахунок"
            className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-300 hover:text-white border border-slate-700 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
          >
            <RefreshCw className={`h-4 w-4 ${loading ? 'animate-spin' : ''}`} />
          </button>
          {collapseControl}
        </div>
        <p className="col-span-3 min-w-0 text-[11px] leading-relaxed text-slate-400 sm:col-start-2 sm:col-span-1">
          Повний аудит: BTC контекст, стакан ордерів, зона POC, деривативи, ризик маніпуляцій та рекомендації
        </p>
      </div>

      {/* Replace ONLY the two upper ratings (market score + generated summary)
          with the detected formation. Retain every AI + Quant module below. */}
      {/* Canonical detected setup: includes real formation Entry/TP/SL and Telegram alerts. */}
      {tradeSetup}

      {/* Only ATR remains from the former independent quantitative trade plan. */}
      <div className="rounded-xl border border-slate-800 bg-slate-950/80 px-4 py-3">
        <div className="flex items-center justify-between gap-3 text-xs">
          <span className="flex items-center gap-2 text-slate-300 font-semibold">
            <Activity className="w-4 h-4 text-cyan-400" />
            ATR (14) / Волатильність
          </span>
          <span className="font-mono text-slate-200">
            {data.volatility.atr} · {data.volatility.atrPct}% від ціни
          </span>
        </div>
        <p className="mt-1 text-[10px] text-slate-500">
          Волатильність — окремий показник, не альтернативні рівні Entry, SL або TP.
        </p>
      </div>

      {/* Only validated measurements; don't describe anonymous orderbook levels
          as on-chain holders, iceberg trades or an identified market maker. */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-2.5 text-xs">
        <div className="p-3 rounded-xl bg-slate-900/80 border border-slate-800 space-y-1.5">
          <span className="flex items-center gap-1.5 text-slate-400"><Wallet className="w-3.5 h-3.5" /> Аналіз Holders</span>
          <strong className="block text-white font-mono">н/д</strong>
          <p className="text-slate-400 text-[10px]">Ончейн-джерело не підключене</p>
        </div>
        <div className="p-3 rounded-xl bg-slate-900/80 border border-slate-800 space-y-1.5">
          <span className="flex items-center gap-1.5 text-slate-400"><Eye className="w-3.5 h-3.5" /> Великі заявки</span>
          <strong className="block text-white font-mono">
            {data.participants.largePlayer.clusterVolumeUsd === null
              ? 'н/д' : formatVolume(data.participants.largePlayer.clusterVolumeUsd)}
          </strong>
          <p className="text-slate-400 text-[10px]">Лімітні заявки, не угоди китів</p>
        </div>
        <div className="p-3 rounded-xl bg-slate-900/80 border border-slate-800 space-y-1.5">
          <span className="flex items-center gap-1.5 text-slate-400"><Radio className="w-3.5 h-3.5" /> Маркет-мейкер</span>
          <strong className="block text-white">Не визначено</strong>
          <p className="text-slate-400 text-[10px]">Одного зрізу стакана недостатньо</p>
        </div>
        <div className="p-3 rounded-xl bg-slate-900/80 border border-slate-800 space-y-1.5">
          <span className="flex items-center gap-1.5 text-slate-400"><ShieldAlert className="w-3.5 h-3.5" /> Вразливість ринку</span>
          <strong className="block text-white font-mono">
            {data.participants.manipulativeCoin.riskScore === null
              ? 'н/д' : data.participants.manipulativeCoin.riskScore + '/100'}
          </strong>
          <p className="text-slate-400 text-[10px]">Евристика, не доказ маніпуляцій</p>
        </div>
      </div>

      {/* Navigation Filter Tabs */}
      <div className="flex items-center gap-1.5 overflow-x-auto no-scrollbar pb-1 border-b border-slate-800 text-xs">
        <button
          onClick={() => setActiveTab('all')}
          className={`px-3 py-1.5 rounded-lg font-semibold transition-all cursor-pointer whitespace-nowrap ${
            activeTab === 'all'
              ? 'bg-indigo-600 text-white shadow-sm'
              : 'text-slate-400 hover:text-white hover:bg-slate-800'
          }`}
        >
          Усі модулі (Повний огляд)
        </button>

        <button
          onClick={() => setActiveTab('btc')}
          className={`px-3 py-1.5 rounded-lg font-semibold transition-all cursor-pointer whitespace-nowrap flex items-center gap-1.5 ${
            activeTab === 'btc'
              ? 'bg-indigo-600 text-white shadow-sm'
              : 'text-slate-400 hover:text-white hover:bg-slate-800'
          }`}
        >
          <span>Контекст BTC (15m → 5m → 1m)</span>
          {data.btcContext.hasSharpImpulse && (
            <span className="w-2 h-2 rounded-full bg-amber-400 animate-ping" />
          )}
        </button>

        <button
          onClick={() => setActiveTab('tech')}
          className={`px-3 py-1.5 rounded-lg font-semibold transition-all cursor-pointer whitespace-nowrap ${
            activeTab === 'tech'
              ? 'bg-indigo-600 text-white shadow-sm'
              : 'text-slate-400 hover:text-white hover:bg-slate-800'
          }`}
        >
          RSI, EMA, Об'єми та Спред
        </button>

        <button
          onClick={() => setActiveTab('orderbook')}
          className={`px-3 py-1.5 rounded-lg font-semibold transition-all cursor-pointer whitespace-nowrap ${
            activeTab === 'orderbook'
              ? 'bg-indigo-600 text-white shadow-sm'
              : 'text-slate-400 hover:text-white hover:bg-slate-800'
          }`}
        >
          Стакан, POC та Ліквідність
        </button>

        <button
          onClick={() => setActiveTab('derivatives')}
          className={`px-3 py-1.5 rounded-lg font-semibold transition-all cursor-pointer whitespace-nowrap ${
            activeTab === 'derivatives'
              ? 'bg-indigo-600 text-white shadow-sm'
              : 'text-slate-400 hover:text-white hover:bg-slate-800'
          }`}
        >
          Open Interest та Деривативи
        </button>

        <button
          onClick={() => setActiveTab('institutional')}
          className={`px-3 py-1.5 rounded-lg font-semibold transition-all cursor-pointer whitespace-nowrap flex items-center gap-1.5 ${
            activeTab === 'institutional'
              ? 'bg-indigo-600 text-white shadow-sm'
              : 'text-indigo-300 bg-indigo-950/40 hover:bg-indigo-900/60 border border-indigo-800/50'
          }`}
        >
          <Fingerprint className="w-3.5 h-3.5 text-cyan-400" />
          <span>Holders, Whales, ММ та Маніпуляції</span>
        </button>
      </div>

      {/* Module 1: BTC Context (15m -> 5m -> 1m) */}
      {(activeTab === 'all' || activeTab === 'btc') && (
        <div className="p-4 rounded-xl bg-slate-950/70 border border-slate-800 space-y-3">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="flex items-center gap-2">
              <Activity className="w-4 h-4 text-amber-400" />
              <h5 className="text-xs font-bold text-white uppercase tracking-wider">
                Контекст BTC на 15m → 5m → 1m
              </h5>
            </div>
            <div className="flex items-center gap-2 text-xs font-mono">
              <span className="text-slate-400">BTC/USDT:</span>
              <span className="font-bold text-white">${formatCryptoPrice(data.btcContext.btcPrice)}</span>
              <span className={`font-bold ${data.btcContext.change24h >= 0 ? 'text-emerald-400' : 'text-rose-400'}`}>
                {data.btcContext.change24h >= 0 ? '+' : ''}{data.btcContext.change24h.toFixed(2)}%
              </span>
            </div>
          </div>

          {/* Sharp impulse alert banner if active */}
          {data.btcContext.hasSharpImpulse && (
            <div className="p-2.5 rounded-lg bg-amber-950/40 border border-amber-500/50 flex items-center gap-2 text-xs text-amber-200">
              <AlertTriangle className="w-4 h-4 text-amber-400 shrink-0 animate-bounce" />
              <span>
                <strong>Увага!</strong> {data.btcContext.impulseDescription}
              </span>
            </div>
          )}

          {/* Timeframe Cards */}
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-2.5">
            {(['15m', '5m', '1m'] as const).map((tf) => {
              const item = data.btcContext.timeframes[tf];
              const isUp = item.direction === 'up';
              const isHH = item.structure === 'HH_HL';
              const isLL = item.structure === 'LH_LL';

              return (
                <div
                  key={tf}
                  className={`p-3 rounded-lg border flex flex-col justify-between space-y-2 ${
                    isHH
                      ? 'bg-emerald-950/20 border-emerald-800/40'
                      : isLL
                      ? 'bg-rose-950/20 border-rose-800/40'
                      : 'bg-slate-900/60 border-slate-800'
                  }`}
                >
                  <div className="flex items-center justify-between">
                    <span className="text-xs font-bold font-mono text-cyan-300">BTC {tf}</span>
                    <span
                      className={`px-1.5 py-0.2 rounded text-[10px] font-bold uppercase font-mono ${
                        isHH
                          ? 'bg-emerald-500/20 text-emerald-300 border border-emerald-500/30'
                          : isLL
                          ? 'bg-rose-500/20 text-rose-300 border border-rose-500/30'
                          : 'bg-slate-700/40 text-slate-300'
                      }`}
                    >
                      {item.structure}
                    </span>
                  </div>

                  <div className="flex items-center gap-1.5">
                    {isUp ? (
                      <TrendingUp className="w-4 h-4 text-emerald-400" />
                    ) : (
                      <TrendingDown className="w-4 h-4 text-rose-400" />
                    )}
                    <span className="text-xs font-semibold text-slate-200 truncate">
                      {item.label}
                    </span>
                  </div>
                </div>
              );
            })}
          </div>

          {/* Overall Structure & Upcoming Macro News */}
          <div className="grid grid-cols-1 md:grid-cols-2 gap-2.5 pt-1 text-xs">
            <div className="p-3 rounded-lg bg-slate-900/80 border border-slate-800">
              <span className="text-[11px] text-slate-400 block mb-1 font-medium">Загальна структура BTC:</span>
              <p className="text-slate-200 font-medium leading-relaxed">
                {data.btcContext.overallStructureLabel}
              </p>
            </div>

            <div className="p-3 rounded-lg bg-slate-900/80 border border-slate-800">
              <span className="text-[11px] text-amber-400 flex items-center gap-1 mb-1 font-medium">
                <Calendar className="w-3.5 h-3.5" />
                Наближення важливих новин та тригерів:
              </span>
              <div className="space-y-1">
                {data.btcContext.upcomingNews.map((news, idx) => (
                  <div key={idx} className="flex items-center justify-between text-[11px] text-slate-300">
                    <span className="truncate mr-2">• {news.title}</span>
                    <span className="font-mono text-amber-300 shrink-0">{news.timeUntil}</span>
                  </div>
                ))}
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Module 2: Technicals (RSI, EMA, Volume Spike, Spread, Range) */}
      {(activeTab === 'all' || activeTab === 'tech') && (
        <div className="p-4 rounded-xl bg-slate-950/70 border border-slate-800 space-y-3">
          <div className="flex items-center gap-2">
            <Gauge className="w-4 h-4 text-cyan-400" />
            <h5 className="text-xs font-bold text-white uppercase tracking-wider">
              Тренд на основі RSI, Ковзних Середніх та Волатильності
            </h5>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-2.5 text-xs">
            {/* RSI */}
            <div className="p-3 rounded-lg bg-slate-900/80 border border-slate-800 space-y-2">
              <div className="flex items-center justify-between text-slate-400">
                <span>RSI (14)</span>
                <span className="font-mono font-bold text-white">{data.trend.rsi14}</span>
              </div>
              <div className="w-full bg-slate-800 h-2 rounded-full overflow-hidden">
                <div
                  className={`h-full transition-all ${
                    data.trend.rsi14 > 70
                      ? 'bg-rose-500'
                      : data.trend.rsi14 < 30
                      ? 'bg-emerald-500'
                      : 'bg-cyan-500'
                  }`}
                  style={{ width: `${Math.min(data.trend.rsi14, 100)}%` }}
                />
              </div>
              <span className="text-[11px] text-slate-300 block">{data.trend.rsiLabel}</span>
            </div>

            {/* EMA Cross & Status */}
            <div className="p-3 rounded-lg bg-slate-900/80 border border-slate-800 space-y-1.5">
              <span className="text-slate-400 block">Сигнал ковзних середніх</span>
              <span className="font-bold text-white block truncate">{data.trend.crossSignalLabel}</span>
              <div className="flex items-center gap-2 text-[10px] font-mono text-slate-400">
                <span>EMA20: {data.trend.ema20}</span>
                <span>•</span>
                <span>EMA50: {data.trend.ema50}</span>
              </div>
            </div>

            {/* 1h Volume & Spike */}
            <div className="p-3 rounded-lg bg-slate-900/80 border border-slate-800 space-y-1.5">
              <div className="flex items-center justify-between text-slate-400">
                <span>Об'єм за останню 1 год</span>
                {data.volumeMetrics.hasVolumeSpike && (
                  <span className="px-1.5 py-0.2 rounded text-[10px] bg-amber-500/20 text-amber-300 font-bold border border-amber-500/40">
                    СПЛЕСК x{data.volumeMetrics.volume1hSpikeRatio}
                  </span>
                )}
              </div>
              <span className="font-bold text-white text-sm font-mono block">
                {formatVolume(data.volumeMetrics.volume1hUsd)}
              </span>
              <span className="text-[10px] text-slate-400 block font-sans">
                24h оборот: {formatVolume(data.volumeMetrics.volume24hUsd)}
              </span>
            </div>

            {/* Spread & Quality */}
            <div className="p-3 rounded-lg bg-slate-900/80 border border-slate-800 space-y-1.5">
              <span className="text-slate-400 block">Поточний Спред (Spread)</span>
              <div className="flex items-baseline gap-2">
                <span className="font-bold text-white text-sm font-mono">
                  {data.spread.spreadPct}%
                </span>
                <span className="text-[10px] text-slate-400 font-mono">
                  (${data.spread.spreadUsd})
                </span>
              </div>
              <span className="text-[10px] text-emerald-400 block font-medium">
                {data.spread.quality === 'ultra_tight'
                  ? 'Ультра-вузький (найвища ліквідність)'
                  : data.spread.quality === 'normal'
                  ? 'Звичайний робочий спред'
                  : 'Широкий спред (ризик прослизання)'}
              </span>
            </div>
          </div>

          {/* Position in Day Range */}
          <div className="p-3 rounded-lg bg-slate-900/80 border border-slate-800 space-y-1.5 text-xs">
            <div className="flex items-center justify-between text-slate-300">
              <span className="font-medium">
                Де знаходиться ціна відносно денного High/Low:
              </span>
              <span className="font-mono font-bold text-cyan-400">
                {data.volatility.positionInDayRangePct}% від мінімуму дня
              </span>
            </div>

            <div className="w-full bg-slate-800 h-2.5 rounded-full relative overflow-hidden flex">
              <div
                className="bg-gradient-to-r from-rose-500 via-amber-400 to-emerald-500 h-full rounded-full"
                style={{ width: `${data.volatility.positionInDayRangePct}%` }}
              />
            </div>

            <div className="flex justify-between text-[10px] font-mono text-slate-400">
              <span>Day Low: ${formatCryptoPrice(data.volatility.low24h)}</span>
              <span>Day High: ${formatCryptoPrice(data.volatility.high24h)}</span>
            </div>
          </div>
        </div>
      )}

      {/* Module 3: Orderbook, POC & Liquidity Pools */}
      {(activeTab === 'all' || activeTab === 'orderbook') && (
        <div className="p-4 rounded-xl bg-slate-950/70 border border-slate-800 space-y-3">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <Layers className="w-4 h-4 text-emerald-400" />
              <h5 className="text-xs font-bold text-white uppercase tracking-wider">
                Стакан ордерів, Зона POC та Рівні Ліквідності
              </h5>
            </div>
            <span className="text-xs text-slate-400 font-mono">
              Дисбаланс Bid/Ask = <strong className="text-white">{data.orderbook.bidAskRatio}</strong>
            </span>
          </div>

          {/* Orderbook Walls & POC */}
          <div className="grid grid-cols-1 md:grid-cols-3 gap-2.5 text-xs font-mono">
            {/* Long Wall (Bid) */}
            <div className="p-3 rounded-lg bg-emerald-950/20 border border-emerald-800/40 space-y-1">
              <span className="text-[10px] text-emerald-400 font-sans block font-semibold">
                Найбільша стіна в лонг (Bid Wall):
              </span>
              <div className="text-sm font-bold text-white">
                {formatCryptoPrice(data.orderbook.bidWallPrice)}
              </div>
              <div className="text-[11px] text-emerald-300">
                Обсяг стіни: {formatVolume(data.orderbook.bidWallUsd)}
              </div>
            </div>

            {/* POC Zone */}
            <div className="p-3 rounded-lg bg-indigo-950/20 border border-indigo-800/40 space-y-1">
              <span className="text-[10px] text-indigo-300 font-sans block font-semibold">
                Point of Control (Зона POC об'єму):
              </span>
              <div className="text-sm font-bold text-white">
                {formatCryptoPrice(data.levels.pocPrice)}
              </div>
              <div className="text-[11px] text-indigo-300">
                Концентрація: ~{data.levels.pocVolumePct}% об'єму
              </div>
            </div>

            {/* Short Wall (Ask) */}
            <div className="p-3 rounded-lg bg-rose-950/20 border border-rose-800/40 space-y-1">
              <span className="text-[10px] text-rose-400 font-sans block font-semibold">
                Найбільша стіна в шорт (Ask Wall):
              </span>
              <div className="text-sm font-bold text-white">
                {formatCryptoPrice(data.orderbook.askWallPrice)}
              </div>
              <div className="text-[11px] text-rose-300">
                Обсяг стіни: {formatVolume(data.orderbook.askWallUsd)}
              </div>
            </div>
          </div>

          {/* Detected Large Orders List */}
          {data.orderbook.largeOrders.length > 0 && (
            <div className="p-3 rounded-lg bg-slate-900/80 border border-slate-800 space-y-2 text-xs">
              <span className="font-semibold text-slate-300 flex items-center gap-1.5 text-xs">
                <Crosshair className="w-3.5 h-3.5 text-cyan-400" />
                Виявлені великі лімітні заявки в стакані (Whale & Large Walls):
              </span>

              <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-2">
                {data.orderbook.largeOrders.slice(0, 4).map((order, idx) => (
                  <div
                    key={idx}
                    className={`p-2 rounded border flex items-center justify-between text-xs font-mono ${
                      order.side === 'bid'
                        ? 'bg-emerald-950/20 border-emerald-800/40 text-emerald-300'
                        : 'bg-rose-950/20 border-rose-800/40 text-rose-300'
                    }`}
                  >
                    <div>
                      <span className="text-[10px] uppercase font-bold block">
                        {order.side === 'bid' ? 'КУПІВЛЯ (BID)' : 'ПРОДАЖ (ASK)'}
                      </span>
                      <span className="font-bold text-white">
                        {formatCryptoPrice(order.price)}
                      </span>
                    </div>
                    <div className="text-right">
                      <span className="font-bold block">{formatVolume(order.amountUsd)}</span>
                      <span className="text-[9px] text-slate-400">{order.distancePct}% від поточної</span>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Liquidity Levels & S/R */}
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 text-xs">
            <div className="p-3 rounded-lg bg-slate-900/80 border border-slate-800">
              <span className="font-semibold text-slate-300 block mb-1.5">
                Найближчі пули ліквідності:
              </span>
              <div className="space-y-1 font-mono text-[11px]">
                {data.levels.liquidityLevels.map((liq, i) => (
                  <div key={i} className="flex items-center justify-between text-slate-300">
                    <span className="text-slate-400 truncate mr-2">{liq.label}</span>
                    <span className="text-white font-bold">{formatCryptoPrice(liq.price)}</span>
                  </div>
                ))}
              </div>
            </div>

            <div className="p-3 rounded-lg bg-slate-900/80 border border-slate-800">
              <span className="font-semibold text-slate-300 block mb-1.5">
                Сильні опорні рівні (Support / Resistance):
              </span>
              <div className="space-y-1.5 font-mono text-[11px]">
                <div className="flex items-center justify-between">
                  <span className="text-emerald-400">Сильна підтримка (Demand):</span>
                  <span className="text-white font-bold">{formatCryptoPrice(data.levels.strongSupport)}</span>
                </div>
                <div className="flex items-center justify-between">
                  <span className="text-rose-400">Сильний опір (Supply):</span>
                  <span className="text-white font-bold">{formatCryptoPrice(data.levels.strongResistance)}</span>
                </div>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Module 4: Derivatives & Open Interest */}
      {(activeTab === 'all' || activeTab === 'derivatives') && (
        <div className="p-4 rounded-xl bg-slate-950/70 border border-slate-800 space-y-3">
          <div className="flex items-center gap-2">
            <BarChart3 className="w-4 h-4 text-indigo-400" />
            <h5 className="text-xs font-bold text-white uppercase tracking-wider">
              Деривативи, Графік Open Interest (Binance & Bybit) та Funding Rate
            </h5>
          </div>

          {/* Unavailable values are explicit; never show synthetic OI as market evidence. */}
          {data.derivatives.oiCoverage === 'spot' && (
            <p className="text-[11px] text-amber-200">
              Для спотових пар Open Interest не застосовується. Перемкніться на ф'ючерси.
            </p>
          )}
          {data.derivatives.oiCoverage === 'partial' && (
            <p className="text-[11px] text-amber-300">
              Доступний OI лише однієї біржі. Сума неповна і не підходить для підтвердження входу.
            </p>
          )}
          {data.derivatives.oiCoverage === 'none' && (
            <p className="text-[11px] text-amber-300">
              Реальних актуальних даних OI наразі немає. Оцінки та графіки не підставляються.
            </p>
          )}
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-2.5 text-xs font-mono">
            {([
              { label: 'Binance Futures', info: data.derivatives.binanceOI, color: 'bg-cyan-500/60' },
              { label: 'Bybit Linear', info: data.derivatives.bybitOI, color: 'bg-indigo-500/60' },
            ]).map(source => (
              <div key={source.label} className="p-3 rounded-lg bg-slate-900/80 border border-slate-800 space-y-2">
                <div className="flex items-center justify-between text-slate-400 font-sans gap-2">
                  <span>OI {source.label}</span>
                  <span className="text-[10px]">
                    {source.info.change1hPct === null
                      ? 'Δ1h: н/д'
                      : `${source.info.change1hPct > 0 ? '+' : ''}${source.info.change1hPct}% (1h)`}
                  </span>
                </div>
                <div className="text-base font-bold text-white">
                  {source.info.currentUsd === null ? 'Немає даних' : formatVolume(source.info.currentUsd)}
                </div>
                {source.info.history.length >= 3 ? (
                  <div className="flex items-end gap-1 h-6 pt-1" title="Реальна історія OI, лише послідовні свічки">
                    {source.info.history.map((value, index) => {
                      const low = Math.min(...source.info.history);
                      const high = Math.max(...source.info.history);
                      const heightPct = high > low ? Math.max(((value - low) / (high - low)) * 100, 15) : 50;
                      return <div key={index} className={`flex-1 rounded-t ${source.color}`}
                        style={{ height: `${heightPct}%` }} title={formatVolume(value)} />;
                    })}
                  </div>
                ) : (
                  <p className="text-[10px] text-slate-500 font-sans">Історія відсутня або з пропусками</p>
                )}
              </div>
            ))}
            <div className="p-3 rounded-lg bg-slate-900/80 border border-slate-800 space-y-1.5">
              <div className="flex items-center justify-between text-slate-400 font-sans">
                <span>Funding Rate</span>
                <span className="text-[10px]">{data.derivatives.hasPerpFutures ? 'PERP' : 'SPOT'}</span>
              </div>
              <div className="text-base font-bold text-white">
                {data.derivatives.fundingRate === null ? 'Немає даних'
                  : `${data.derivatives.fundingRate > 0 ? '+' : ''}${data.derivatives.fundingRate}%`}
              </div>
              <p className="text-[10px] text-slate-400 font-sans">
                Bybit funding: {data.derivatives.predictedFundingRate === null
                  ? 'н/д' : `${data.derivatives.predictedFundingRate}%`}
              </p>
              <p className="text-[10px] text-slate-400 font-sans">
                {data.derivatives.totalOIUsd === null ? 'Сумарний OI: н/д'
                  : `${data.derivatives.oiCoverage === 'partial' ? 'OI доступної біржі' : 'Сумарний OI'}: ${formatVolume(data.derivatives.totalOIUsd)}`}
              </p>
            </div>
          </div>
        </div>
      )}

      {/* Institutional diagnostics: distinguish observed quotes from unverified
          participants. Keep all four topics, but never manufacture wallet data. */}
      {(activeTab === 'all' || activeTab === 'institutional') && (
        <div className="p-4 rounded-xl bg-slate-950/80 border border-indigo-900/40 space-y-4">
          <div className="flex items-center gap-2 border-b border-slate-800/80 pb-3">
            <Fingerprint className="w-4 h-4 text-cyan-400" />
            <h5 className="text-xs font-bold text-white uppercase tracking-wider">
              Інституційні індикатори та межі достовірності
            </h5>
          </div>
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-3.5 text-xs">
            <section className="p-3.5 rounded-xl bg-slate-900/80 border border-slate-800 space-y-2">
              <h6 className="flex items-center gap-2 font-bold text-white">
                <Wallet className="w-4 h-4 text-emerald-400" />
                1. Аналіз Holders & Розподіл Гаманців
              </h6>
              <dl className="grid grid-cols-2 gap-2 text-[11px]">
                <div><dt className="text-slate-400">Топ-10 гаманців</dt><dd className="text-white">н/д</dd></div>
                <div><dt className="text-slate-400">Активні адреси (24h)</dt><dd className="text-white">н/д</dd></div>
                <div className="col-span-2"><dt className="text-slate-400">Retail / Whale</dt><dd className="text-white">н/д</dd></div>
              </dl>
              <p className="text-slate-400 text-[11px]">{data.participants.holders.phaseDescription}</p>
            </section>

            <section className="p-3.5 rounded-xl bg-slate-900/80 border border-slate-800 space-y-2">
              <h6 className="flex items-center gap-2 font-bold text-white">
                <Eye className="w-4 h-4 text-cyan-400" />
                2. Великі лімітні заявки
              </h6>
              <p className="text-[11px] text-slate-400">
                Обсяг у поточному знімку: <strong className="text-white">
                {data.participants.largePlayer.clusterVolumeUsd === null
                  ? 'н/д' : formatVolume(data.participants.largePlayer.clusterVolumeUsd)}
                </strong>
              </p>
              <div className="space-y-1.5">
                {data.participants.largePlayer.trackedClusters.length > 0
                  ? data.participants.largePlayer.trackedClusters.map((cluster, index) => (
                    <div key={index} className="flex flex-wrap items-center justify-between gap-2 rounded bg-slate-950/70 border border-slate-800 px-2 py-1.5 text-[11px]">
                      <span className="text-slate-300">
                        {cluster.side === 'buy' ? 'BID' : 'ASK'} · {formatCryptoPrice(cluster.price)}
                      </span>
                      <strong className="font-mono text-white">{formatVolume(cluster.volumeUsd)}</strong>
                    </div>
                  )) : <p className="text-slate-400">Немає підтверджених великих заявок у поточному зрізі або дані недоступні.</p>}
              </div>
              <p className="text-slate-400 text-[11px]">{data.participants.largePlayer.details}</p>
            </section>

            <section className="p-3.5 rounded-xl bg-slate-900/80 border border-slate-800 space-y-2">
              <h6 className="flex items-center gap-2 font-bold text-white">
                <Radio className="w-4 h-4 text-indigo-400" />
                3. Маркет-мейкер
              </h6>
              <p className="text-slate-300 text-[11px]">
                Підтверджений спред вибраного ринку: <strong className="text-white">
                  {data.spread.spreadPct === null ? 'н/д' : data.spread.spreadPct + '%'}
                </strong>
              </p>
              <p className="text-slate-400 text-[11px]">Алгоритм, швидкість поновлення, особа маркет-мейкера та захист від сквизу: н/д.</p>
              <p className="text-slate-400 text-[11px]">{data.participants.marketMaker.details}</p>
            </section>

            <section className="p-3.5 rounded-xl bg-slate-900/80 border border-slate-800 space-y-2">
              <h6 className="flex items-center gap-2 font-bold text-white">
                <ShieldAlert className="w-4 h-4 text-amber-400" />
                4. Індекс ринкової вразливості
              </h6>
              <p className="font-mono text-lg font-bold text-white">
                {data.participants.manipulativeCoin.riskScore === null
                  ? 'н/д' : data.participants.manipulativeCoin.riskScore + ' / 100'}
              </p>
              <div className="space-y-1.5">
                {data.participants.manipulativeCoin.signals.map((sig, index) => (
                  <div key={index} className="flex items-start gap-2 rounded bg-slate-950/70 border border-slate-800 p-2 text-[11px]">
                    {sig.detected === true
                      ? <AlertTriangle className="w-3.5 h-3.5 shrink-0 text-amber-400" />
                      : <CheckCircle2 className="w-3.5 h-3.5 shrink-0 text-cyan-400" />}
                    <div>
                      <span className="font-semibold text-white">{sig.name}</span>
                      <p className="text-slate-400">{sig.description}</p>
                    </div>
                  </div>
                ))}
                {data.participants.manipulativeCoin.signals.length === 0 && (
                  <p className="text-slate-400">Достовірні показники для оцінки недоступні.</p>
                )}
              </div>
              <p className="text-amber-200 text-[11px]">
                {data.participants.manipulativeCoin.warningSummary}
              </p>
            </section>
          </div>
        </div>
      )}
    </div>
  );
};
