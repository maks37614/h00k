import React, { useState, useEffect } from 'react';
import {
  ExternalLink,
  TrendingUp,
  TrendingDown,
  Star,
  Target,
  ShieldAlert,
  Zap,
  Send,
  Radar,
  BarChart2,
  X,
  RefreshCw,
  ChevronDown,
} from 'lucide-react';
import { ScannedCoin, DetectedFormation, Kline, Timeframe } from '../types';
import { formatCryptoPrice } from '../utils/formatters';
import { useArchive } from '../context/ArchiveContext';
import { useSurveillance } from '../context/SurveillanceContext';
import { TradingViewChart } from './TradingViewChart';

const QUALITY_LABELS: Record<string, string> = {
  formation: 'Формація', extremeLocation: 'Екстремум', trigger: 'Пробій',
  retest: 'Ретест', volume: 'RVOL', volatility: 'ATR',
  level: 'Рівень', riskReward: 'R:R', dataQuality: 'Якість даних',
  openInterest: 'OI · Δ', delta: 'Дельта', cvd20: 'CVD20',
  roundNumber: 'Кругле число', density: 'Щільність BID/ASK',
  rsi: 'RSI14', atr: 'ATR/SL/TP', rvol: 'RVOL пробою',
};

interface FormationCardProps {
  coin: ScannedCoin;
  formation: DetectedFormation;
  formations?: DetectedFormation[];
  isWatchlisted: boolean;
  onToggleWatchlist: (symbol: string) => void;
  onSelect: (coin: ScannedCoin, formation: DetectedFormation) => void;
  onSendMetaScalp?: (coin: ScannedCoin) => void;
  metaScalpBinding?: string;
  onOpenAlert?: (coin: ScannedCoin, formation: DetectedFormation) => void;
}

export const FormationCard: React.FC<FormationCardProps> = ({
  coin,
  formation: primaryFormation,
  formations,
  isWatchlisted,
  onToggleWatchlist,
  onSelect,
  onSendMetaScalp,
  metaScalpBinding = '001',
  onOpenAlert,
}) => {
  const [selectedPatternId, setSelectedPatternId] = useState<string | null>(null);
  const formation = formations?.find((pattern) => pattern.id === selectedPatternId) ?? primaryFormation;
  const { isArchived } = useArchive();
  const archived = isArchived(coin.symbol, formation.id || formation.name);
  const { isCoinMonitored, isCoinOnSurveillance, addCoinToSurveillance, removeCoinFromSurveillance, coins: survCoins } = useSurveillance();
  const isMonitored = isCoinOnSurveillance(coin.symbol, coin.exchange);
  const isActive = isCoinMonitored(coin.symbol, coin.exchange);

  const [isChartExpanded, setIsChartExpanded] = useState<boolean>(false);
  const [klines, setKlines] = useState<Kline[]>([]);
  const [loadingKlines, setLoadingKlines] = useState<boolean>(false);
  const [cardTimeframe, setCardTimeframe] = useState<Timeframe>(coin.timeframe || '1h');
  const [livePrice, setLivePrice] = useState<number>(coin.currentPrice);
  const [isConfluenceExpanded, setIsConfluenceExpanded] = useState<boolean>(false);

  const selectFormation = (pattern: DetectedFormation) => {
    setSelectedPatternId(pattern.id);
    setIsConfluenceExpanded(false);
  };

  // Native dropdowns open above scroll containers on desktop and mobile without
  // enlarging the card or clipping the list of patterns.
  const renderFormationSelector = () => {
    if (!formations || formations.length < 2) {
      return <span className="block min-w-0 truncate font-bold text-xs text-slate-200" title={formation.name}>{formation.name}</span>;
    }

    return (
      <div className="relative flex min-w-0 max-w-full flex-1 items-center">
        <select
          value={formation.id}
          onChange={(event) => {
            const selected = formations.find((pattern) => pattern.id === event.target.value);
            if (selected) selectFormation(selected);
          }}
          aria-label={`Вибрати формацію для ${coin.baseAsset} — ${formations.length} варіанти`}
          title={`Натисніть на назву, щоб вибрати одну з ${formations.length} формацій`}
          className="block w-full min-w-0 appearance-none truncate rounded-md border border-cyan-500/40 bg-cyan-500/10 py-1 pl-1.5 pr-8 text-left text-xs font-semibold text-cyan-100 hover:bg-cyan-500/20 focus:outline-none focus:border-cyan-400 cursor-pointer"
        >
          {formations.map((pattern) => (
            <option key={pattern.id} value={pattern.id} className="bg-slate-900 text-slate-100">
              {pattern.name}
            </option>
          ))}
        </select>
        <ChevronDown className="pointer-events-none absolute right-2 h-3 w-3 text-cyan-300" />
      </div>
    );
  };

  useEffect(() => {
    if (!isChartExpanded) return;
    let isCancelled = false;
    async function fetchCardKlines() {
      setLoadingKlines(true);
      try {
        const res = await fetch(
          `/api/klines?exchange=${coin.exchange}&market=${coin.marketType}&symbol=${coin.symbol}&timeframe=${cardTimeframe}&limit=200`
        );
        const data = await res.json();
        if (!isCancelled && data.success && Array.isArray(data.data)) {
          setKlines(data.data);
          if (data.data.length > 0) {
            setLivePrice(data.data[data.data.length - 1].close);
          }
        }
      } catch (err) {
        console.error('Failed to load card klines:', err);
      } finally {
        if (!isCancelled) setLoadingKlines(false);
      }
    }
    fetchCardKlines();
    return () => {
      isCancelled = true;
    };
  }, [isChartExpanded, cardTimeframe, coin]);

  const isPositive = coin.priceChange24h >= 0;
  const isBullish = formation.bias === 'bullish';
  const isBearish = formation.bias === 'bearish';

  const formatPrice = (price: number) => formatCryptoPrice(price);

  return (
    <div
      className={`bg-slate-900/80 border transition-all rounded-2xl flex flex-col justify-between hover:shadow-xl group min-w-0 w-full min-h-[350px] ${
        isChartExpanded
          ? 'formation-chart-card border-cyan-500 shadow-xl shadow-cyan-950/40 bg-slate-900 p-2 sm:p-2.5 h-[390px]'
          : 'border-slate-800 hover:border-slate-700 hover:shadow-cyan-950/20 p-3 sm:p-3.5 h-[350px]'
      }`}
    >
      {/* If Chart is expanded, the interactive chart takes over the entire block */}
      {isChartExpanded ? (
        <div className="flex-1 flex flex-col w-full h-full min-h-0 relative">
          {/* Use the card's available width: desktop grid columns may be narrower than mobile. */}
          <div className="formation-chart-header relative z-30 px-1 py-1 mb-1 border-b border-slate-800/80 shrink-0">
            <div className="formation-chart-identity">
              <span
                className="formation-chart-symbol font-mono font-extrabold text-white text-xs sm:text-sm"
                title={`${coin.baseAsset}/${coin.quoteAsset}`}
              >
                {coin.baseAsset}/{coin.quoteAsset}
              </span>
              <span className="shrink-0 text-[10px] px-1.5 py-0.5 rounded bg-slate-800 text-slate-300 font-mono uppercase">
                {coin.exchange}
              </span>
              <span className="formation-chart-price shrink-0 font-mono font-bold text-xs text-cyan-400">
                ${formatPrice(livePrice)}
              </span>
            </div>

            <div className="formation-chart-header-actions">
              {onSendMetaScalp && (
                <button
                  type="button"
                  onClick={(e) => {
                    e.stopPropagation();
                    onSendMetaScalp(coin);
                  }}
                  title={`MetaScalp (${metaScalpBinding})`}
                  aria-label={`Відправити в MetaScalp (${metaScalpBinding})`}
                  className="rounded-lg bg-amber-500/10 hover:bg-amber-500/20 text-amber-300 border border-amber-500/30 transition-colors cursor-pointer"
                >
                  <Zap className="w-3.5 h-3.5 text-amber-400 fill-amber-400/30" />
                </button>
              )}

              <button
                type="button"
                onClick={(e) => {
                  e.stopPropagation();
                  onSelect(coin, formation);
                }}
                className="rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-300 hover:text-white border border-slate-700 transition-colors cursor-pointer"
                title="Повний детальний огляд"
                aria-label="Повний детальний огляд"
              >
                <ExternalLink className="w-3.5 h-3.5 text-cyan-400" />
              </button>

              <button
                type="button"
                onClick={() => setIsChartExpanded(false)}
                className="rounded-lg bg-rose-500/10 hover:bg-rose-500/20 text-rose-300 border border-rose-500/30 transition-colors cursor-pointer"
                title="Закрити графік (повернутися до картки)"
                aria-label="Закрити графік (повернутися до картки)"
              >
                <X className="w-3.5 h-3.5" />
              </button>
            </div>
          </div>

          {/* Chart occupying entire remaining area of the block */}
          <div className="flex-1 w-full h-full min-h-0 relative overflow-hidden rounded-xl bg-slate-950 border border-slate-800">
            {loadingKlines && klines.length === 0 && (
              <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 bg-slate-950/80 z-20">
                <RefreshCw className="w-5 h-5 text-cyan-400 animate-spin" />
                <span className="text-[11px] text-slate-400 font-mono">Завантаження свічок...</span>
              </div>
            )}
            <TradingViewChart
              visualContext="formationsQuick"
              klines={klines}
              formation={formation}
              symbol={coin.symbol}
              timeframe={cardTimeframe}
              exchange={coin.exchange}
              marketType={coin.marketType}
              showNavigationControls={false}
              fullHeight={true}
              onLivePriceUpdate={(p) => setLivePrice(p)}
              onTimeframeChange={(tf) => setCardTimeframe(tf)}
            />
          </div>
        </div>
      ) : (
        <>
          {/* Top Bar */}
          <div className="flex items-start justify-between gap-2">
            <div className="flex items-center gap-2">
              <div>
                <div className="flex items-center gap-1.5">
                  <span className="font-extrabold text-base text-white tracking-wide font-mono">
                    {coin.baseAsset}
                  </span>
                  <span className="text-xs text-slate-500 font-mono">/{coin.quoteAsset}</span>
                </div>
                <div className="flex items-center gap-1.5 mt-0.5">
                  <span
                    className={`text-[10px] px-1.5 py-0.2 rounded font-semibold uppercase ${
                      coin.exchange === 'binance'
                        ? 'bg-amber-500/10 text-amber-300 border border-amber-500/20'
                        : 'bg-orange-500/10 text-orange-300 border border-orange-500/20'
                    }`}
                  >
                    {coin.exchange}
                  </span>
                  <span className="text-[10px] px-1.5 py-0.2 rounded bg-slate-800 text-slate-400 font-medium">
                    {coin.marketType === 'futures' ? 'Futures' : 'Spot'}
                  </span>
                  <span className="text-[10px] px-1.5 py-0.2 rounded bg-slate-800 text-slate-400 font-mono">
                    {coin.timeframe}
                  </span>
                </div>
              </div>
            </div>

            {/* Price & 24h Change */}
            <div className="text-right">
              <div className="font-mono font-bold text-sm text-slate-100">
                ${formatPrice(livePrice)}
              </div>
              <div
                className={`text-xs font-semibold flex items-center justify-end gap-0.5 ${
                  isPositive ? 'text-emerald-400' : 'text-rose-400'
                }`}
              >
                {isPositive ? <TrendingUp className="w-3 h-3" /> : <TrendingDown className="w-3 h-3" />}
                {isPositive ? '+' : ''}{coin.priceChange24h.toFixed(2)}%
              </div>
            </div>
          </div>

          {/* Middle Content: Formation Details */}
          <div className="space-y-2 my-1 flex-1 min-h-0 overflow-y-auto touch-scroll">
            {/* Formation Info Block */}
            <div className="bg-slate-950/70 border border-slate-800/80 rounded-xl p-2.5">
              <div className="flex items-center justify-between gap-2 mb-1">
                {renderFormationSelector()}
                <span
                  className={`text-[9px] px-2 py-0.5 rounded font-bold uppercase tracking-wider whitespace-nowrap ${
                    isBullish
                      ? 'bg-emerald-500/20 text-emerald-300 border border-emerald-500/30'
                      : isBearish
                      ? 'bg-rose-500/20 text-rose-300 border border-rose-500/30'
                      : 'bg-amber-500/20 text-amber-300 border border-amber-500/30'
                  }`}
                >
                  {isBullish ? 'LONG ▲' : isBearish ? 'SHORT ▼' : 'NEUTRAL'}
                </span>
                {formation.roundNumberContext?.detected && (
                  <span
                    className={`text-[9px] px-2 py-0.5 rounded font-bold uppercase tracking-wider whitespace-nowrap border ${
                      formation.roundNumberContext.densityConfirmed
                        ? 'bg-fuchsia-500/20 text-fuchsia-200 border-fuchsia-400/50'
                        : 'bg-amber-500/15 text-amber-200 border-amber-400/40'
                    }`}
                    title={formation.roundNumberContext.densityConfirmed ? 'Кругле число + велика лімітна заявка у поточному знімку стакана. Заявка може зникнути; це не гарантія підтримки або опору.' : 'Формація біля круглого числа'}
                  >
                    {formation.roundNumberContext.densityConfirmed ? 'ROUND + DENSITY' : 'ROUND'}
                  </span>
                )}
              </div>

              <div className="flex items-center justify-between text-[11px] text-slate-400 mb-1.5">
                <span>Статус:</span>
                <span className="font-medium text-slate-300 bg-slate-800/80 px-1.5 py-0.5 rounded text-[10px]">
                  {formation.statusLabel}
                </span>
              </div>
              {formation.tpSlBuilder && <div className="mb-1.5 space-y-1">
                <p className="text-[10px] text-cyan-300">Правила профілю
                  {formation.tpSlBuilder.touches
                    ? formation.tpSlBuilder.touches.verified
                      ? ` · дотики ${formation.tpSlBuilder.touches.count}/${formation.tpSlBuilder.touches.required}`
                      : ' · дотики не підтверджені (немає даних)'
                    : ''}
                </p>
                {formation.tpSlBuilder.levelStatus === 'invalid' &&
                  <p className="text-[10px] text-amber-300">Некоректний власний TP/SL — показано автоматичні ціни</p>}
              </div>}

              {/* The same verified metrics drive the regular screener's technical filters. */}
              {coin.regularIndicators && (
                <div className="flex flex-wrap gap-1 mb-1.5 text-[9px] font-mono text-slate-300"
                  aria-label="Технічні показники звичайного сканування">
                  {Number.isFinite(coin.regularIndicators.atrPct) && coin.regularIndicators.atrPct !== null && (
                    <span className="rounded border border-cyan-900/50 bg-cyan-950/25 px-1.5 py-0.5"
                      title="ATR(14) у відсотках від ціни, розрахований із закритих свічок">
                      ATR {coin.regularIndicators.atrPct.toFixed(2)}%
                    </span>
                  )}
                  {Number.isFinite(coin.regularIndicators.rsi14) && coin.regularIndicators.rsi14 !== null && (
                    <span className="rounded border border-slate-700 bg-slate-900 px-1.5 py-0.5"
                      title="RSI(14) останньої закритої свічки">
                      RSI {coin.regularIndicators.rsi14.toFixed(1)}
                    </span>
                  )}
                  {Number.isFinite(coin.regularIndicators.oiChangePct) &&
                    coin.regularIndicators.oiChangePct !== undefined && (
                    <span className="rounded border border-purple-900/50 bg-purple-950/25 px-1.5 py-0.5"
                      title="Зміна реального OI у нативних контрактах за вибраний таймфрейм; лише ф'ючерси">
                      OI {coin.regularIndicators.oiChangePct > 0 ? '+' : ''}{coin.regularIndicators.oiChangePct.toFixed(2)}%
                    </span>
                  )}
                  {Number.isFinite(coin.regularIndicators.deltaPct) &&
                    coin.regularIndicators.deltaPct !== undefined && (
                    <span className="rounded border border-slate-700 bg-slate-900 px-1.5 py-0.5"
                      title="Дельта агресивних покупок мінус продажів Binance, остання закрита свічка">
                      Δ {coin.regularIndicators.deltaPct > 0 ? '+' : ''}{coin.regularIndicators.deltaPct.toFixed(1)}%
                    </span>
                  )}
                  {Number.isFinite(coin.regularIndicators.cvd20Pct) &&
                    coin.regularIndicators.cvd20Pct !== undefined && (
                    <span className="rounded border border-slate-700 bg-slate-900 px-1.5 py-0.5"
                      title="Сумарна taker delta Binance за останні 20 закритих свічок відносно їхнього обороту">
                      CVD20 {coin.regularIndicators.cvd20Pct > 0 ? '+' : ''}{coin.regularIndicators.cvd20Pct.toFixed(1)}%
                    </span>
                  )}
                  {formation.validation?.breakoutConfirmed &&
                    Number.isFinite(formation.validation.volumeRatio) && (
                    <span className="rounded border border-emerald-900/50 bg-emerald-950/25 px-1.5 py-0.5"
                      title="RVOL обсягу свічки підтвердженого пробою проти попередніх 20 закритих свічок">
                      RVOL {formation.validation.volumeRatio.toFixed(2)}×
                    </span>
                  )}
                </div>
              )}

              {formation.validation && (
                <div className={`text-[10px] mb-2 ${formation.validation.passed ? 'text-emerald-300' : 'text-amber-300'}`}>
                  {formation.validation.passed ? 'Вхід підтверджено' : 'Вхід ще не підтверджено'}
                  {!formation.validation.passed && (
                    <p className="text-slate-400 mt-1">{formation.validation.rejectionReasons.slice(0, 2).join(' · ')}</p>
                  )}
                </div>
              )}

              {/* Status of additional flow confirmation, never a replacement for structure. */}
              {formation.validation?.confluence?.flow && (
                <p className={`mb-2 text-[10px] ${formation.validation.confluence.flow.status === 'contradicted'
                  ? 'text-rose-300' : formation.validation.confluence.flow.entryConfirmedWithFlow
                    ? 'text-emerald-300' : 'text-slate-400'}`}
                  title="OI сам не визначає напрямок позицій; дельта й CVD — взаємопов'язані дані.">
                  {formation.validation.confluence.flow.status === 'unavailable'
                    ? 'Потік: немає перевірених даних · без штрафу'
                    : formation.validation.confluence.flow.entryConfirmedWithFlow
                      ? '✓ Вхід додатково підтверджено потоком'
                      : formation.validation.confluence.flow.status === 'contradicted'
                        ? '⚠ Дельта та CVD суперечать входу'
                        : formation.validation.confluence.flow.status === 'supported'
                          ? 'Потік підтримує напрямок; основний вхід ще очікується'
                          : `Потік: ${formation.validation.confluence.flow.supportive}/${formation.validation.confluence.flow.available} факторів підтримують`}
                </p>
              )}

              {/* Detailed confluence */}
              {formation.validation?.confluence && (
                <div className="mt-2 border-t border-slate-800/70 pt-2">
                  <button
                    type="button"
                    onClick={() => setIsConfluenceExpanded((value) => !value)}
                    className="w-full flex items-center justify-between text-[10px] hover:text-slate-200 transition-colors cursor-pointer"
                    aria-expanded={isConfluenceExpanded}
                    title={isConfluenceExpanded ? 'Сховати' : 'Показати'}
                  >
                    <span className="text-slate-400" title="Структура та ринковий потік, нормовані за наявними перевіреними показниками до 100. Не ймовірність успіху.">Якість сигналу:</span>
                    <span className="flex items-center gap-1.5">
                      <span className="font-mono font-bold text-cyan-300">{formation.validation.confluence.total}/100 · {formation.validation.confluence.grade}</span>
                      <ChevronDown
                        className={`w-3 h-3 text-slate-500 transition-transform ${isConfluenceExpanded ? 'rotate-180' : ''}`}
                      />
                    </span>
                  </button>

                  {isConfluenceExpanded && (
                    <div className="mt-1">
                      <div className="grid grid-cols-3 gap-1 text-[8px]">
                        {Object.entries(formation.validation.confluence.components)
                          // Remove density from this visual list only; scoring and filters are untouched.
                          .filter(([key]) => key !== 'density')
                          .map(([key, item]) => (
                          <details key={key}
                            className={`bg-slate-900/70 rounded px-1.5 py-1 border ${item.available === false
                              ? 'border-slate-800/50 opacity-70'
                              : item.status === 'CONFLICT' ? 'border-rose-800/60' : 'border-slate-800'}`}>
                            <summary className="cursor-pointer list-none focus-visible:outline focus-visible:outline-2 focus-visible:outline-cyan-400"
                              title={item.evidence}>
                              <div className="text-slate-400 truncate">{QUALITY_LABELS[key] ?? key}</div>
                              <div className={`font-mono ${item.status === 'CONFLICT' ? 'text-rose-300' : 'text-slate-200'}`}>
                                {item.available === false ? `н/д / ${item.max}` : `${item.score}/${item.max}`}
                              </div>
                            </summary>
                            <p className="mt-1 border-t border-slate-800 pt-1 text-[9px] text-slate-400 break-words leading-3">
                              {item.evidence}
                            </p>
                          </details>
                        ))}
                      </div>
                      {formation.validation.confluence.rawTotal !== undefined
                        && formation.validation.confluence.availableMax !== undefined && (
                        <p className="mt-1 text-[9px] text-slate-400">
                          Нормовано: {formation.validation.confluence.rawTotal}/{formation.validation.confluence.availableMax}
                          {' '}доступних балів → {formation.validation.confluence.total}/100.
                          Відсутні показники не зменшують оцінку. Натисни на складову для пояснення.
                        </p>
                      )}
                      {(formation.validation.confluence.conflicts.length > 0 || formation.validation.confluence.missing.length > 0) && (
                        <div className="mt-1 text-[8px] text-amber-300">
                          {formation.validation.confluence.conflicts.slice(0, 2).join(' · ')}
                          {formation.validation.confluence.missing.length > 0 && ` Очікується: ${formation.validation.confluence.missing.slice(0, 2).join(', ')}`}
                        </div>
                      )}
                    </div>
                  )}
                </div>
              )}

              {/* Confidence meter */}
              <div className="mt-2">
                <div className="w-full bg-slate-800 h-1 rounded-full overflow-hidden">
                  <div
                    className={`h-full rounded-full ${
                      formation.confidence >= 85
                        ? 'bg-gradient-to-r from-cyan-500 to-emerald-400'
                        : 'bg-gradient-to-r from-blue-500 to-cyan-400'
                    }`}
                    style={{ width: `${formation.confidence}%` }}
                  />
                </div>
              </div>
            </div>

            {/* Trade Geometry: Target, Stop Loss, Risk/Reward */}
            <div className="grid grid-cols-3 gap-1.5 text-center text-xs">
              <div className="bg-slate-950/50 border border-slate-800/60 p-1.5 rounded-lg min-w-0">
                <div className="text-[10px] text-slate-400 flex items-center justify-center gap-0.5 truncate">
                  <Target className="w-2.5 h-2.5 text-emerald-400 shrink-0" />
                  <span className="truncate">Ціль</span>
                </div>
                <div className="font-mono font-bold text-emerald-400 text-xs mt-0.5">
                  +{formation.potentialProfitPct}%
                </div>
                <div className="text-[9px] text-slate-500 font-mono truncate">
                  ${formatPrice(formation.levels.targetPrice)}
                </div>
              </div>

              <div className="bg-slate-950/50 border border-slate-800/60 p-1.5 rounded-lg min-w-0">
                <div className="text-[10px] text-slate-400 flex items-center justify-center gap-0.5 truncate">
                  <ShieldAlert className="w-2.5 h-2.5 text-rose-400 shrink-0" />
                  <span className="truncate">Стоп</span>
                </div>
                <div className="font-mono font-bold text-rose-400 text-xs mt-0.5">
                  -{Math.abs(formation.potentialRiskPct)}%
                </div>
                <div className="text-[9px] text-slate-500 font-mono truncate">
                  ${formatPrice(formation.levels.stopLossPrice)}
                </div>
              </div>

              <div className="bg-slate-950/50 border border-slate-800/60 p-1.5 rounded-lg min-w-0">
                <div className="text-[10px] text-slate-400 truncate">Вхід / R:R</div>
                <div className="font-mono font-bold text-sky-400 text-xs mt-0.5 truncate">
                  {formation.tpSlBuilder?.touches?.ready === false
                    ? 'Очікування дотиків' : String.fromCharCode(36) + formatPrice(formation.levels.entryPrice)}
                </div>
                <div className="text-[9px] text-cyan-300 font-mono font-medium">
                  1:{formation.riskRewardRatio}
                </div>
              </div>
            </div>
          </div>

          {/* Footer Actions */}
          <div className="flex items-center justify-between gap-2 pt-2 border-t border-slate-800/60">
            <div className="flex items-center gap-1.5">
              <button
                onClick={() => setIsChartExpanded(true)}
                className="flex items-center gap-1.5 py-1.5 px-3 rounded-xl bg-cyan-600/20 hover:bg-cyan-600/30 border border-cyan-500/30 text-cyan-300 text-xs font-semibold transition-colors shadow-sm cursor-pointer"
                title="Відкрити графік на цілий блок"
              >
                <BarChart2 className="w-3.5 h-3.5 text-cyan-400" />
                <span></span>
              </button>

              <button
                onClick={(e) => {
                  e.stopPropagation();
                  onSelect(coin, formation);
                }}
                className="p-1.5 rounded-xl bg-slate-800/80 hover:bg-slate-700 border border-slate-700/60 text-slate-400 hover:text-cyan-300 transition-colors cursor-pointer"
                title="Повний детальний огляд монети"
              >
                <ExternalLink className="w-3.5 h-3.5" />
              </button>
            </div>

            <div className="flex items-center gap-2">
              {onSendMetaScalp && (
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    onSendMetaScalp(coin);
                  }}
                  title={`Відкрити в MetaScalp (Група ${metaScalpBinding})`}
                  className="flex items-center gap-1 py-1.5 px-2 rounded-xl bg-amber-500/10 hover:bg-amber-500/20 border border-amber-500/30 text-amber-300 hover:text-amber-200 text-xs font-semibold transition-all active:scale-95 cursor-pointer"
                >
                  <Zap className="w-3.5 h-3.5 text-amber-400 fill-amber-400/30" />
                </button>
              )}

              {onOpenAlert && (
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    onOpenAlert(coin, formation);
                  }}
                  title="Створити сповіщення ціни в Telegram"
                  className="p-2 rounded-xl bg-sky-500/10 hover:bg-sky-500/20 border border-sky-500/30 text-sky-400 hover:text-sky-300 transition-colors cursor-pointer"
                >
                  <Send className="w-3.5 h-3.5" />
                </button>
              )}

              <button
                onClick={async (e) => {
                  e.stopPropagation();
                  if (isMonitored) {
                    const found = survCoins.find((c) => c.symbol === coin.symbol && c.exchange === coin.exchange);
                    if (found) await removeCoinFromSurveillance(found.id);
                  } else {
                    await addCoinToSurveillance(coin.symbol, coin.exchange, coin.marketType);
                  }
                }}
                title={
                  isMonitored
                    ? `Монета на системному нагляді (${isActive ? 'Активна 24/7' : 'Призупинена'}). Натисніть щоб зняти`
                    : 'Взяти на 24/7 системний нагляд'
                }
                className={`p-2 rounded-xl border transition-colors cursor-pointer ${
                  isMonitored
                    ? 'bg-violet-500/20 border-violet-500/40 text-violet-400'
                    : 'bg-slate-800/70 hover:bg-slate-800 border-slate-700/60 text-slate-400 hover:text-violet-400'
                }`}
              >
                <Radar className={`w-3.5 h-3.5 ${isMonitored ? 'animate-pulse' : ''}`} />
              </button>

              <button
                onClick={() => onToggleWatchlist(coin.symbol)}
                title={isWatchlisted ? 'Видалити з обраного' : 'Додати в обране'}
                className={`p-2 rounded-xl border transition-colors cursor-pointer ${
                  isWatchlisted
                    ? 'bg-amber-500/20 border-amber-500/40 text-amber-400'
                    : 'bg-slate-800/70 hover:bg-slate-800 border-slate-700/60 text-slate-400 hover:text-amber-400'
                }`}
              >
                <Star className={`w-3.5 h-3.5 ${isWatchlisted ? 'fill-amber-400' : ''}`} />
              </button>
            </div>
          </div>
        </>
      )}
    </div>
  );
};
