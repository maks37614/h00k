import React, { useState, useEffect } from 'react';
import {
  Gauge,
  TrendingUp,
  TrendingDown,
  DollarSign,
  Activity,
  BarChart2,
  PieChart,
  RefreshCw,
  Zap,
  ChevronDown,
  ChevronUp,
  ShieldCheck,
  AlertCircle,
} from 'lucide-react';
import { MarketSentimentData, MarketCoin } from '../types';
import { formatVolume, formatPercent } from '../utils/formatters';
import { MarketSentimentScale } from './MarketSentimentScale';

interface MarketSentimentWidgetProps {
  coins?: MarketCoin[];
}

export const MarketSentimentWidget: React.FC<MarketSentimentWidgetProps> = ({ coins }) => {
  const [data, setData] = useState<MarketSentimentData | null>(null);
  const [loading, setLoading] = useState<boolean>(true);
  const [error, setError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<boolean>(false);

  const fetchSentiment = async () => {
    setLoading(true);
    try {
      const res = await fetch('/api/market/sentiment');
      const json = await res.json();
      if (!res.ok || json.success !== true || !json.data ||
          !Number.isFinite(json.data.compositeScore) ||
          json.data.compositeScore < 0 || json.data.compositeScore > 100) {
        throw new Error('Ринкові дані тимчасово недоступні');
      }
      setData(json.data);
      setError(null);
    } catch (err) {
      setError('Не вдалося оновити індекс. Перевірте з’єднання або стан бірж.');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchSentiment();
    const interval = setInterval(fetchSentiment, 30000);
    return () => clearInterval(interval);
  }, []);

  if (!data) {
    return (
      <div className="rounded-2xl border border-slate-800/90 bg-slate-900/90 p-4 text-sm text-slate-300" role="status">
        <div className="flex items-center justify-between gap-3">
          <span>Настрій ринку: {loading ? 'Завантаження даних…' : 'Немає достовірних даних'}</span>
          <button type="button" onClick={fetchSentiment} disabled={loading}
            className="rounded-lg border border-slate-700 px-2.5 py-1 text-xs text-cyan-300 disabled:opacity-50">
            Оновити
          </button>
        </div>
        {error && <p className="mt-2 text-xs text-amber-300">{error}</p>}
      </div>
    );
  }

  return (
    <div className="rounded-2xl bg-gradient-to-r from-slate-900 via-slate-900/85 to-indigo-950/40 border border-slate-800/90 shadow-lg backdrop-blur-md overflow-hidden lg:mx-auto lg:max-w-5xl">
      {/* Compact heading and sentiment segments share a row when space allows. */}
      <div className="flex min-w-0 flex-wrap items-center gap-x-2 border-b border-slate-800/70">
        <div className="flex w-full shrink-0 items-center justify-between gap-3 px-3 pt-3 sm:px-4 md:w-auto md:py-3 md:pl-4 md:pr-0">
          <div className="flex min-w-0 items-center gap-2.5">
            <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-xl border border-indigo-500/30 bg-gradient-to-br from-indigo-500/20 to-cyan-500/20 text-indigo-400 shadow-inner">
              <Gauge className="h-4 w-4" />
            </div>
            <div>
              <h3 className="whitespace-nowrap text-xs font-bold uppercase tracking-wide text-white sm:text-sm">
                Настрій Ринку
              </h3>
              <p className="sr-only">
                Орієнтовний індекс із перевіреної цінової динаміки, обсягів та доступних історичних рівнів
              </p>
            </div>
          </div>

          <div className="flex shrink-0 items-center gap-1.5">
            <button
              onClick={fetchSentiment}
              disabled={loading}
              className="cursor-pointer rounded-lg border border-slate-700/60 bg-slate-800/80 p-1.5 text-slate-400 transition-colors hover:bg-slate-800 hover:text-white"
              title="Оновити дані"
              aria-label="Оновити дані"
            >
              <RefreshCw className={`h-3.5 w-3.5 ${loading ? 'animate-spin' : ''}`} />
            </button>

            <button
              onClick={() => setExpanded(!expanded)}
              className="cursor-pointer rounded-lg border border-slate-700/60 bg-slate-800/80 p-1.5 text-slate-400 transition-colors hover:bg-slate-800 hover:text-white"
              title={expanded ? 'Згорнути' : 'Розгорнути'}
              aria-label={expanded ? 'Згорнути' : 'Розгорнути'}
              aria-expanded={expanded}
            >
              {expanded ? <ChevronUp className="h-3.5 w-3.5" /> : <ChevronDown className="h-3.5 w-3.5" />}
            </button>
          </div>
        </div>

        {/* Live 0–100 API reading; only its visual presentation changes. */}
        <div className="min-w-[220px] flex-[1_1_240px]">
          <MarketSentimentScale score={data.compositeScore} sentimentLabel={data.sentimentLabel} />
        </div>
      </div>

      {(error || (data.dataQuality && data.dataQuality.totalSources > 0 &&
        data.dataQuality.freshSources < data.dataQuality.totalSources)) && (
        <p role="status" className="border-b border-amber-500/20 px-3 py-2 text-[11px] text-amber-300 sm:px-4">
          {error ? 'Оновлення не вдалося — показані останні отримані дані.' :
            `Частина джерел ринку недоступна або застаріла (${data.dataQuality?.freshSources}/${data.dataQuality?.totalSources} актуальних).`}
        </p>
      )}

      {/* Main Content Body */}
      {expanded && (
        <div className="p-3 sm:p-4 space-y-3 sm:space-y-4">
          {/* Summary Banner */}
          <p className="text-xs text-slate-300 leading-relaxed bg-slate-950/50 p-2.5 sm:p-3 rounded-xl border border-slate-800/60">
            {data.summary}
          </p>

          {/* 6 Sub-Indicators Grid */}
          <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-2 sm:gap-2.5 text-xs font-mono">
            {/* 1. Динаміка ціни та тренду */}
            <div className="p-2.5 sm:p-3 rounded-xl bg-slate-950/60 border border-slate-800 flex flex-col justify-between space-y-1.5">
              <div className="flex items-center justify-between text-slate-400 text-[11px] font-sans">
                <span className="truncate">Тренд &amp; Динаміка</span>
                {data.priceTrendDynamics.trendBias === 'bullish' ? (
                  <TrendingUp className="w-3.5 h-3.5 text-emerald-400 shrink-0" />
                ) : (
                  <TrendingDown className="w-3.5 h-3.5 text-rose-400 shrink-0" />
                )}
              </div>

              <div>
                <span className="text-base sm:text-lg font-bold text-white block">
                  {data.priceTrendDynamics.advancingPct}%
                </span>
                <span className="text-[10px] text-slate-400 font-sans block">
                  {data.priceTrendDynamics.advancingCount} ростуть / {data.priceTrendDynamics.decliningCount} падають
                </span>
              </div>
            </div>

            {/* 2. Обсяги торгів */}
            <div className="p-2.5 sm:p-3 rounded-xl bg-slate-950/60 border border-slate-800 flex flex-col justify-between space-y-1.5">
              <div className="flex items-center justify-between text-slate-400 text-[11px] font-sans">
                <span className="truncate">Обсяги торгів</span>
                <DollarSign className="w-3.5 h-3.5 text-cyan-400 shrink-0" />
              </div>

              <div>
                <span className="text-base sm:text-lg font-bold text-white block">
                  {formatVolume(data.tradingVolume.total24hUsd)}
                </span>
                <span className="text-[10px] text-emerald-400 font-sans block">
                  Сумарний оборот за 24 год
                </span>
              </div>
            </div>

            {/* 3. Волатильність */}
            <div className="p-2.5 sm:p-3 rounded-xl bg-slate-950/60 border border-slate-800 flex flex-col justify-between space-y-1.5">
              <div className="flex items-center justify-between text-slate-400 text-[11px] font-sans">
                <span className="truncate">Волатильність</span>
                <Activity className="w-3.5 h-3.5 text-amber-400 shrink-0" />
              </div>

              <div>
                <span className="text-base sm:text-lg font-bold text-amber-300 block">
                  {data.marketVolatility.avgDailyRangePct}%
                </span>
                <span className="text-[10px] text-slate-400 font-sans block truncate" title={data.marketVolatility.label}>
                  Індекс: {data.marketVolatility.index}/100
                </span>
              </div>
            </div>

            {/* 4. Ширина ринку */}
            <div className="p-2.5 sm:p-3 rounded-xl bg-slate-950/60 border border-slate-800 flex flex-col justify-between space-y-1.5">
              <div className="flex items-center justify-between text-slate-400 text-[11px] font-sans">
                <span className="truncate">Ширина ринку</span>
                <BarChart2 className="w-3.5 h-3.5 text-indigo-400 shrink-0" />
              </div>

              <div>
                <span className="text-base sm:text-lg font-bold text-indigo-300 block">
                  {data.marketBreadth.breadthScore} / 100
                </span>
                <span className="text-[10px] text-slate-400 font-sans block truncate">
                  EMA20: {data.marketBreadth.aboveEma20Pct === null ? 'н/д' : `${data.marketBreadth.aboveEma20Pct}% вище`}
                </span>
              </div>
            </div>

            {/* 5. Припливи / Відтоки капіталу */}
            <div className="p-2.5 sm:p-3 rounded-xl bg-slate-950/60 border border-slate-800 flex flex-col justify-between space-y-1.5">
              <div className="flex items-center justify-between text-slate-400 text-[11px] font-sans">
                <span className="truncate">Рух капіталу</span>
                <PieChart className="w-3.5 h-3.5 text-emerald-400 shrink-0" />
              </div>

              <div>
                <span className="block text-base font-bold text-slate-400 sm:text-lg">
                  {data.capitalFlow.netInflow24hUsd === null ? 'н/д' :
                    formatVolume(Math.abs(data.capitalFlow.netInflow24hUsd))}
                </span>
                <span className="block truncate font-sans text-[10px] text-slate-400" title={data.capitalFlow.label}>
                  {data.capitalFlow.label}
                </span>
              </div>
            </div>

            {/* 6. Відкритий інтерес та Funding Rate */}
            <div className="p-2.5 sm:p-3 rounded-xl bg-slate-950/60 border border-slate-800 flex flex-col justify-between space-y-1.5">
              <div className="flex items-center justify-between text-slate-400 text-[11px] font-sans">
                <span className="truncate">OI &amp; Funding</span>
                <Zap className="w-3.5 h-3.5 text-cyan-400 shrink-0" />
              </div>

              <div>
                <span className="text-base sm:text-lg font-bold text-cyan-300 block">
                  {data.derivativesOverview.aggregatedOIUsd === null ? 'н/д' : formatVolume(data.derivativesOverview.aggregatedOIUsd)}
                </span>
                <span className="text-[10px] text-slate-400 font-sans block truncate">
                  Фандинг: {data.derivativesOverview.avgFundingRate === null ? 'н/д' : `${data.derivativesOverview.avgFundingRate}%`}
                </span>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
