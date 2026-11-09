import React, { useState, useEffect, useMemo } from 'react';
import { createPortal } from 'react-dom';
import {
  X,
  Send,
  Zap,
  TrendingUp,
  TrendingDown,
  Star,
  Search,
  ChevronLeft,
  ChevronRight,
  Trash2,
  ChevronUp,
  ChevronDown,
} from 'lucide-react';
import { Kline, DetectedFormation, Timeframe, ExchangeId, MarketType, ChartMarkerInfo, ChartRestoreParams, ScannedCoin } from '../types';
import { TradingViewChart } from './TradingViewChart';
import { normalizeExchangeSymbol } from '../utils/marketSymbols';
import { formatCryptoPrice } from '../utils/formatters';
import { fetchDirectKlines } from '../utils/directExchangeClient';
import { defaultEarlyFormationLevelVisibility, earlyFormationChartMarkers, filterEarlyFormationChartMarkers, type EarlyFormationCandidate, type EarlyFormationLevelKey } from '../utils/earlyFormations';
import { applyClosedEarlyWickTouch, type TpSlRule } from '../utils/tpSlConstructor';

interface FullscreenChartModalProps {
  isOpen: boolean;
  onClose: () => void;
  coin: {
    symbol: string;
    baseAsset: string;
    quoteAsset: string;
    exchange: ExchangeId;
    marketType: MarketType;
    currentPrice: number;
    priceChange24h: number;
    volume24hUsd?: number;
    exchangeUrl?: string;
  };
  formation?: DetectedFormation | null;
  /** Unconfirmed early scenario; never treated as a validated formation. */
  earlyCandidate?: EarlyFormationCandidate | null;
  /** Opt-in personal wick rule for the already-open chart stream. */
  earlyTouchRule?: TpSlRule;
  klines?: Kline[];
  currentTimeframe: string;
  onTimeframeChange?: (tf: Timeframe) => void;
  livePrice?: number | null;
  onOpenTelegramModal?: (data: any) => void;
  onSendMetaScalp?: (coin: any) => void;
  metaScalpBinding?: string;
  onAddToArchive?: () => void;
  isArchived?: boolean;
  customMarkers?: ChartMarkerInfo[];
  savedChartParams?: ChartRestoreParams;
  allCoins?: ScannedCoin[];
  watchlist?: string[];
  onToggleWatchlist?: (symbol: string) => void;
}

export const FullscreenChartModal: React.FC<FullscreenChartModalProps> = ({
  isOpen,
  onClose,
  coin,
  formation,
  earlyCandidate,
  earlyTouchRule,
  klines = [],
  currentTimeframe,
  onTimeframeChange,
  livePrice,
  onOpenTelegramModal,
  onSendMetaScalp,
  metaScalpBinding = '001',
  onAddToArchive,
  isArchived,
  customMarkers,
  savedChartParams,
  allCoins = [],
  watchlist = [],
  onToggleWatchlist,
}) => {
  const [activeCoin, setActiveCoin] = useState(coin);
  const [chartLivePrice, setChartLivePrice] = useState<number | null>(null);
  const [liveStatus, setLiveStatus] = useState<{ isConnected: boolean; mode: 'ws' | 'rest' }>({ isConnected: false, mode: 'rest' });

  useEffect(() => {
    setChartLivePrice(null);
    setLiveStatus({ isConnected: false, mode: 'rest' });
  }, [isOpen, activeCoin.symbol, activeCoin.exchange, activeCoin.marketType]);
  const [earlyLevelVisibility, setEarlyLevelVisibility] = useState(defaultEarlyFormationLevelVisibility);
  const [liveEarlyCandidate, setLiveEarlyCandidate] = useState<EarlyFormationCandidate | null>(earlyCandidate ?? null);
  useEffect(() => setLiveEarlyCandidate(earlyCandidate ?? null), [earlyCandidate]);
  const displayedEarlyCandidate = earlyCandidate && liveEarlyCandidate?.id === earlyCandidate.id
    && liveEarlyCandidate.observedAt === earlyCandidate.observedAt
      ? liveEarlyCandidate : earlyCandidate;
  // Collapsing the controls does not change which forecast lines are visible.
  const [areEarlyLevelControlsExpanded, setAreEarlyLevelControlsExpanded] = useState(true);
  const [isFavoritesDrawerOpen, setIsFavoritesDrawerOpen] = useState<boolean>(false);
  const [searchQuery, setSearchQuery] = useState<string>('');
  const [localWatchlist, setLocalWatchlist] = useState<string[]>(() => {
    try {
      const initial = watchlist && watchlist.length > 0 ? watchlist : JSON.parse(localStorage.getItem('crypto_screener_watchlist') || '[]');
      return Array.isArray(initial) ? Array.from(new Set(initial)) : [];
    } catch {
      return [];
    }
  });

  // Sync localWatchlist with prop if parent updates
  useEffect(() => {
    if (watchlist && watchlist.length > 0) {
      setLocalWatchlist(Array.from(new Set(watchlist)));
    }
  }, [watchlist]);

  // Sync activeCoin with parent coin prop when symbol changes
  useEffect(() => {
    setActiveCoin(coin);
  }, [coin.symbol]);

  const [activeKlines, setActiveKlines] = useState<Kline[]>(klines);

  // Sync activeKlines with parent klines prop
  useEffect(() => {
    if (klines && klines.length > 0) {
      setActiveKlines(klines);
    }
  }, [klines]);

  const [timeframe, setTimeframe] = useState<string>(currentTimeframe || '15m');

  // Keep native chart candle history up to date for the selected coin and timeframe.
  useEffect(() => {
    if (!isOpen) return;
    let isCancelled = false;

    async function fetchPatternKlines() {
      const cleanSym = normalizeExchangeSymbol(activeCoin.symbol);
      try {
        const res = await fetch(
          `/api/klines?exchange=${activeCoin.exchange}&market=${activeCoin.marketType}&symbol=${encodeURIComponent(cleanSym)}&timeframe=${timeframe}&limit=1000`
        );
        const json = await res.json();
        if (!isCancelled && json.success && Array.isArray(json.data) && json.data.length > 0) {
          setActiveKlines(json.data);
          return;
        }

        const direct = await fetchDirectKlines(activeCoin.exchange, activeCoin.marketType, cleanSym, timeframe as Timeframe, 1000);
        if (!isCancelled && direct.length > 0) {
          setActiveKlines(direct);
        }
      } catch {
        try {
          const direct = await fetchDirectKlines(activeCoin.exchange, activeCoin.marketType, cleanSym, timeframe as Timeframe, 1000);
          if (!isCancelled && direct.length > 0) {
            setActiveKlines(direct);
          }
        } catch {}
      }
    }

    fetchPatternKlines();

    return () => {
      isCancelled = true;
    };
  }, [isOpen, activeCoin.symbol, activeCoin.exchange, activeCoin.marketType, timeframe]);
  // Remove symbol from favorites
  const handleRemoveFromWatchlist = (sym: string, e: React.MouseEvent) => {
    e.stopPropagation();
    setLocalWatchlist((prev) => {
      const next = prev.filter((s) => s !== sym);
      try {
        localStorage.setItem('crypto_screener_watchlist', JSON.stringify(next));
      } catch {}
      return next;
    });
    onToggleWatchlist?.(sym);
  };

  // Build full coin list for favorites
  const favoriteCoins = useMemo(() => {
    const uniqueSymbols: string[] = Array.from(new Set<string>(localWatchlist));
    const coinsMap = new Map<string, ScannedCoin>();
    allCoins.forEach((c) => {
      if (!coinsMap.has(c.symbol)) {
        coinsMap.set(c.symbol, c);
      }
    });

    return uniqueSymbols.map((sym: string) => {
      const found = coinsMap.get(sym);
      if (found) return found;
      const clean = sym.toUpperCase();
      const base = clean.replace(/(USDT|BUSD|USDC)$/, '') || clean;
      const quote = clean.slice(base.length) || 'USDT';
      return {
        symbol: clean,
        baseAsset: base,
        quoteAsset: quote,
        exchange: 'binance' as ExchangeId,
        marketType: 'futures' as MarketType,
        currentPrice: 0,
        priceChange24h: 0,
        formations: [],
      } as unknown as ScannedCoin;
    });
  }, [allCoins, localWatchlist]);

  // Filter favorites by search query
  const filteredFavorites = useMemo(() => {
    if (!searchQuery.trim()) return favoriteCoins;
    const q = searchQuery.toLowerCase().trim();
    return favoriteCoins.filter(
      (c) =>
        c.symbol.toLowerCase().includes(q) ||
        c.baseAsset.toLowerCase().includes(q)
    );
  }, [favoriteCoins, searchQuery]);

  // Handle clicking a favorite coin to switch chart
  const handleSelectFavoriteCoin = (favCoin: ScannedCoin) => {
    setActiveCoin({
      symbol: favCoin.symbol,
      baseAsset: favCoin.baseAsset,
      quoteAsset: favCoin.quoteAsset,
      exchange: favCoin.exchange,
      marketType: favCoin.marketType,
      currentPrice: favCoin.currentPrice,
      priceChange24h: favCoin.priceChange24h,
      volume24hUsd: favCoin.volume24hUsd,
      exchangeUrl: favCoin.exchangeUrl,
    });
  };

  // Sync internal timeframe if parent changes
  useEffect(() => {
    if (currentTimeframe) {
      setTimeframe(currentTimeframe);
    }
  }, [currentTimeframe]);

  // Handle escape key to close
  useEffect(() => {
    if (!isOpen) return;

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        onClose();
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [isOpen, onClose]);

  // Prevent background body scroll when open
  useEffect(() => {
    if (!isOpen) return;

    const originalOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';

    return () => {
      document.body.style.overflow = originalOverflow;
    };
  }, [isOpen]);

  const handleTimeframeSelect = (tf: Timeframe) => {
    setTimeframe(tf);
    onTimeframeChange?.(tf);
  };

  const showEarlyLevels = !!earlyCandidate
    && activeCoin.symbol === coin.symbol
    && activeCoin.exchange === coin.exchange
    && activeCoin.marketType === coin.marketType;
  const visibleChartMarkers = useMemo(() => {
    if (!displayedEarlyCandidate) return customMarkers;
    if (!showEarlyLevels) return [];
    const markers = displayedEarlyCandidate.tpSlBuilder
      ? earlyFormationChartMarkers(displayedEarlyCandidate)
      : customMarkers ?? earlyFormationChartMarkers(displayedEarlyCandidate);
    return filterEarlyFormationChartMarkers(
      markers, displayedEarlyCandidate, earlyLevelVisibility,
    );
  }, [displayedEarlyCandidate, customMarkers, earlyLevelVisibility, showEarlyLevels]);
  const toggleEarlyLevel = (level: EarlyFormationLevelKey) =>
    setEarlyLevelVisibility(previous => ({ ...previous, [level]: !previous[level] }));

  if (!isOpen) return null;

  const displayPrice = chartLivePrice ?? (
    activeCoin.symbol === coin.symbol && livePrice
      ? livePrice
      : activeCoin.currentPrice
  );
  const isPositive = activeCoin.priceChange24h >= 0;
  const isBullish = formation?.bias === 'bullish';
  const isBearish = formation?.bias === 'bearish';

  const content = (
    <div
      className="fixed inset-0 z-[100] w-screen h-[100dvh] max-h-[100dvh] min-h-[100dvh] bg-[#090d16] flex flex-col overflow-hidden animate-in fade-in duration-200"
      role="dialog"
      aria-modal="true"
      aria-label="Повноекранний графік HookChart"
    >
      {/* Top Fullscreen Header & Controls */}
      <header className="h-12 sm:h-14 bg-slate-950/95 border-b border-slate-800 px-2.5 sm:px-4 flex items-center justify-between gap-2 shrink-0 z-20 overflow-x-auto no-scrollbar touch-scroll">
        {/* Left: Instrument and price. Exit remains available via the right-hand close button. */}
        <div className="flex items-center gap-2 sm:gap-3 shrink-0">
          {/* Symbol & Exchange Badges */}
          <div className="flex items-center gap-1.5">
            <span className="font-mono font-extrabold text-white text-sm sm:text-base tracking-wide">
              {activeCoin.baseAsset}/{activeCoin.quoteAsset}
            </span>

              <div
                className={`flex items-center gap-1 sm:gap-1.5 px-1.5 sm:px-2 py-0.5 rounded-full border text-[10px] sm:text-[11px] font-mono font-medium ${
                  liveStatus.isConnected
                    ? 'bg-emerald-950/70 border-emerald-700/60 text-emerald-300'
                    : 'bg-slate-800/80 border-slate-700 text-slate-400'
                }`}
                title={`Оновлення в реальному часі (${liveStatus.mode.toUpperCase()})`}
              >
                <span className="relative flex h-2 w-2">
                  <span
                    className={`animate-ping absolute inline-flex h-full w-full rounded-full opacity-75 ${
                      liveStatus.isConnected ? 'bg-emerald-400' : 'bg-slate-400'
                    }`}
                  ></span>
                  <span
                    className={`relative inline-flex rounded-full h-2 w-2 ${
                      liveStatus.isConnected ? 'bg-emerald-500' : 'bg-slate-500'
                    }`}
                  ></span>
                </span>
                <span className="font-bold tracking-wider">
                  {liveStatus.mode === 'ws' ? '⚡' : '●'}
                </span>
              </div>

            <span
              className={`text-[10px] px-1.5 py-0.5 rounded font-bold uppercase ${
                activeCoin.exchange === 'binance'
                  ? 'bg-amber-500/15 text-amber-300 border border-amber-500/30'
                  : 'bg-orange-500/15 text-orange-300 border border-orange-500/30'
              }`}
            >
              {activeCoin.exchange}
            </span>

            <span className="text-[10px] px-1.5 py-0.5 rounded bg-slate-800 text-slate-400 font-medium hidden xs:inline-block">
              {activeCoin.marketType === 'futures' ? 'Futures' : 'Spot'}
            </span>
          </div>

          {/* Real-time Price */}
          <div
            className={`flex items-center gap-1 px-2 py-0.5 rounded-lg border text-xs font-mono font-bold shrink-0 ${
              isPositive
                ? 'bg-emerald-950/60 text-emerald-300 border-emerald-800/60'
                : 'bg-rose-950/60 text-rose-300 border-rose-800/60'
            }`}
          >
            <span>${formatCryptoPrice(displayPrice)}</span>
            <span className="text-[10px] hidden sm:inline">
              ({isPositive ? '+' : ''}{activeCoin.priceChange24h.toFixed(2)}%)
            </span>
          </div>

          {/* Formation Bias Badge (if present) */}
          {formation && activeCoin.symbol === coin.symbol && (
            <div
              className={`hidden xl:flex items-center gap-1 px-2 py-0.5 rounded-lg text-xs font-bold uppercase border shrink-0 ${
                isBullish
                  ? 'bg-emerald-500/15 text-emerald-300 border-emerald-500/30'
                  : isBearish
                  ? 'bg-rose-500/15 text-rose-300 border-rose-500/30'
                  : 'bg-amber-500/15 text-amber-300 border border-amber-500/30'
              }`}
              title={formation.name}
            >
              <span>{formation.name}</span>
              <span>{isBullish ? '▲ LONG' : isBearish ? '▼ SHORT' : 'NEUTRAL'}</span>
            </div>
          )}
        </div>

        {/* Right: Quick actions & Exit Button */}
        <div className="flex items-center gap-1.5 sm:gap-2 shrink-0">
          {/* Favorites drawer, directly before Telegram. */}
          <button
            onClick={() => setIsFavoritesDrawerOpen((prev) => !prev)}
            className={`flex items-center gap-1.5 px-2.5 py-1.5 rounded-xl text-xs font-semibold transition-all border cursor-pointer ${
              isFavoritesDrawerOpen
                ? 'bg-amber-500/20 text-amber-300 border-amber-500/40 shadow-sm shadow-amber-950/40'
                : 'bg-slate-900/90 text-slate-300 border-slate-800 hover:text-white hover:border-slate-700'
            }`}
            title={isFavoritesDrawerOpen ? 'Сховати шторку обраних монет' : 'Відкрити шторку обраних монет'}
          >
            <Star className={`w-3.5 h-3.5 text-amber-400 ${localWatchlist.length > 0 ? 'fill-amber-400' : ''}`} />
            <span className="hidden xs:inline">Обрані монети</span>
            <span className="text-[10px] font-mono font-bold text-amber-300">
              {localWatchlist.length}
            </span>
          </button>

          {/* Telegram Alert shortcut */}
          {onOpenTelegramModal && (
            <button
              onClick={() =>
                onOpenTelegramModal({
                  symbol: activeCoin.symbol,
                  exchange: activeCoin.exchange,
                  marketType: activeCoin.marketType,
                  currentPrice: displayPrice,
                  targetPrice: formation?.levels.targetPrice,
                  formationName: formation?.name,
                })
              }
              className="p-1.5 sm:px-2.5 sm:py-1.5 rounded-xl bg-sky-500/10 hover:bg-sky-500/20 text-sky-300 border border-sky-500/30 text-xs font-semibold transition-all active:scale-95 flex items-center gap-1.5 cursor-pointer"
              title="Створити сповіщення в Telegram"
            >
              <Send className="w-3.5 h-3.5 text-sky-400" />
              <span className="hidden xl:inline">Сповіщення</span>
            </button>
          )}

          {/* MetaScalp shortcut */}
          {onSendMetaScalp && (
            <button
              onClick={() => onSendMetaScalp(activeCoin)}
              className="p-1.5 sm:px-2.5 sm:py-1.5 rounded-xl bg-amber-500/10 hover:bg-amber-500/20 text-amber-300 border border-amber-500/30 text-xs font-semibold transition-all active:scale-95 flex items-center gap-1.5 cursor-pointer"
              title={`Надіслати в MetaScalp (Група ${metaScalpBinding})`}
            >
              <Zap className="w-3.5 h-3.5 text-amber-400 fill-amber-400/20" />
              <span className="hidden xl:inline">MetaScalp</span>
            </button>
          )}

          {/* Close Modal X Icon */}
          <button
            onClick={onClose}
            className="p-1.5 sm:p-2 rounded-xl text-slate-400 hover:text-white hover:bg-slate-800 border border-transparent hover:border-slate-700 transition-colors cursor-pointer"
            title="Закрити повноцінний графік (Esc)"
            aria-label="Закрити повноцінний графік"
          >
            <X className="w-5 h-5" />
          </button>
        </div>
      </header>

      {displayedEarlyCandidate && (
        <div className="shrink-0 border-b border-amber-500/30 bg-slate-950/85 px-2 sm:px-3 py-1.5 space-y-1">
          {showEarlyLevels ? (
            <>
              <div className="flex flex-wrap items-center gap-x-1.5 gap-y-0.5 text-[10px] sm:text-[11px] leading-4">
                <strong className="text-amber-200">Можлива формація: {displayedEarlyCandidate.name}</strong>
                <span className="rounded border border-amber-500/30 bg-amber-500/10 px-1 py-0.5 text-[9px] leading-3 text-amber-300">
                  {displayedEarlyCandidate.stage === 'forming' ? 'Формується' : 'Потенційна'}
                </span>
                <span className="text-slate-400">Попередній сценарій, не підтверджений сигнал</span>
                {displayedEarlyCandidate.tpSlBuilder && (
                  <span className={displayedEarlyCandidate.tpSlBuilder.touches.ready
                    ? 'text-emerald-300' : 'text-amber-300'}
                    aria-live="polite">
                    Дотики {displayedEarlyCandidate.bias === 'bullish' ? 'Low' : 'High'}:
                    {' '}{displayedEarlyCandidate.tpSlBuilder.touches.verified
                      ? `${displayedEarlyCandidate.tpSlBuilder.touches.count}/${displayedEarlyCandidate.tpSlBuilder.touches.required}`
                      : 'немає перевірених даних'}
                    {' · '}{displayedEarlyCandidate.tpSlBuilder.touches.ready
                      ? 'умову дотиків виконано' : 'очікуємо'} (після закриття свічки)
                  </span>
                )}
                {!displayedEarlyCandidate.tickVerified && (
                  <span className="text-orange-300" title="Не вдалося отримати біржовий крок ціни; рівні лише орієнтовні">
                    Крок ціни не перевірено
                  </span>
                )}
                <button type="button"
                  onClick={() => setAreEarlyLevelControlsExpanded(expanded => !expanded)}
                  aria-expanded={areEarlyLevelControlsExpanded}
                  aria-controls="early-formation-level-controls"
                  aria-label={areEarlyLevelControlsExpanded ? 'Згорнути панель прогнозних міток' : 'Розгорнути панель прогнозних міток'}
                  title={areEarlyLevelControlsExpanded ? 'Згорнути мітки' : 'Розгорнути мітки'}
                  className="ml-auto inline-flex shrink-0 items-center gap-0.5 rounded border border-slate-700 bg-slate-800/70 px-1 py-0.5 text-[9px] leading-3 font-semibold text-cyan-200 hover:bg-slate-700 focus-visible:outline focus-visible:outline-2 focus-visible:outline-cyan-400">
                  <span>Мітки</span>
                  {areEarlyLevelControlsExpanded
                    ? <ChevronUp className="h-3 w-3" aria-hidden="true" />
                    : <ChevronDown className="h-3 w-3" aria-hidden="true" />}
                </button>
              </div>
              <div id="early-formation-level-controls"
                className={areEarlyLevelControlsExpanded
                  ? 'flex flex-wrap items-center gap-1 sm:gap-1.5 font-mono'
                  : 'hidden'}
                role="group" aria-label="Натисніть на прогнозний рівень, щоб увімкнути або вимкнути його лінії на графіку">
                {([
                  { key: 'earlyEntry', name: 'Ранній вхід', value: displayedEarlyCandidate.tpSlBuilder?.touches.ready === false ? `Очікування дотиків ${displayedEarlyCandidate.tpSlBuilder.touches.count}/${displayedEarlyCandidate.tpSlBuilder.touches.required}` : `${formatCryptoPrice(displayedEarlyCandidate.earlyEntryMin)} – ${formatCryptoPrice(displayedEarlyCandidate.earlyEntryMax)}`, color: 'text-sky-300 border-sky-500/30 bg-sky-500/10' },
                  { key: 'breakoutEntry', name: 'Вхід після пробою', value: displayedEarlyCandidate.tpSlBuilder?.touches.ready === false ? 'Очікування дотиків' : `${formatCryptoPrice(displayedEarlyCandidate.breakoutEntry)}`, color: 'text-violet-300 border-violet-500/30 bg-violet-500/10' },
                  { key: 'target', name: 'Прогноз TP', value: `$${formatCryptoPrice(displayedEarlyCandidate.target)}`, color: 'text-emerald-300 border-emerald-500/30 bg-emerald-500/10' },
                  { key: 'earlyStop', name: 'SL ранній', value: `$${formatCryptoPrice(displayedEarlyCandidate.stopLoss)}`, color: 'text-rose-300 border-rose-500/30 bg-rose-500/10' },
                  { key: 'breakoutStop', name: 'SL пробій', value: `$${formatCryptoPrice(displayedEarlyCandidate.breakoutStopLoss)}`, color: 'text-orange-300 border-orange-500/30 bg-orange-500/10' },
                  { key: 'neckline', name: 'Шия', value: `$${formatCryptoPrice(displayedEarlyCandidate.neckline)}`, color: 'text-amber-300 border-amber-500/30 bg-amber-500/10' },
                ] as const).map(level => (
                  <button key={level.key} type="button"
                    onClick={() => toggleEarlyLevel(level.key)}
                    aria-pressed={earlyLevelVisibility[level.key]}
                    aria-label={`${level.name}: ${level.value}. ${earlyLevelVisibility[level.key] ? 'Приховати' : 'Показати'} лінію на графіку`}
                    title={earlyLevelVisibility[level.key] ? `Приховати ${level.name}` : `Показати ${level.name}`}
                    className={`inline-flex shrink-0 whitespace-nowrap items-center gap-x-1 rounded-md border px-1.5 py-1 text-[10px] leading-4 sm:text-[11px] text-left transition-colors hover:brightness-125 focus-visible:outline focus-visible:outline-2 focus-visible:outline-cyan-400 ${earlyLevelVisibility[level.key] ? level.color : 'bg-slate-900/60 border-slate-800 text-slate-500 line-through'}`}>
                    <span>{level.name}:</span>
                    <strong>{level.value}</strong>
                  </button>
                ))}
              </div>
            </>
          ) : (
            <p className="text-[11px] text-amber-200">
              Можлива формація: {displayedEarlyCandidate.name}. Прогноз приховано — відкрито іншу монету або ринок.
            </p>
          )}
        </div>
      )}

      {/* Fullscreen Chart Display Area (100% remaining viewport) */}
      <main className="flex-1 min-h-0 w-full relative overflow-hidden bg-[#090d16]">
        {/* Collapsible Left Drawer (Шторка зліва з обраними монетами) */}
        <div
          className={`absolute top-0 bottom-0 left-0 z-30 w-72 sm:w-80 bg-slate-950/95 border-r border-slate-800 backdrop-blur-md flex flex-col shadow-2xl transition-transform duration-300 ease-in-out ${
            isFavoritesDrawerOpen ? 'translate-x-0' : '-translate-x-full pointer-events-none'
          }`}
        >
          {/* Drawer Header */}
          <div className="p-3 border-b border-slate-800 flex items-center justify-between bg-slate-900/80">
            <div className="flex items-center gap-2">
              <Star className="w-4 h-4 text-amber-400 fill-amber-400" />
              <span className="font-bold text-xs sm:text-sm text-white">Обрані монети</span>
              <span className="text-[10px] font-mono font-bold text-amber-300">
                {localWatchlist.length}
              </span>
            </div>
            <button
              onClick={() => setIsFavoritesDrawerOpen(false)}
              className="p-1 rounded-lg text-slate-400 hover:text-white hover:bg-slate-800 transition-colors cursor-pointer"
              title="Сховати шторку"
            >
              <X className="w-4 h-4" />
            </button>
          </div>

          {/* Search Input in Drawer */}
          <div className="p-2.5 border-b border-slate-800/80 bg-slate-950/60">
            <div className="relative">
              <Search className="w-3.5 h-3.5 absolute left-2.5 top-1/2 -translate-y-1/2 text-slate-500" />
              <input
                type="text"
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                placeholder="Пошук в обраному..."
                className="w-full bg-slate-900 border border-slate-800 rounded-lg pl-8 pr-3 py-1.5 text-xs text-slate-200 placeholder:text-slate-500 focus:outline-none focus:border-cyan-500"
              />
            </div>
          </div>

          {/* Coins List in Drawer */}
          <div className="flex-1 overflow-y-auto p-2 space-y-1.5 touch-scroll">
            {filteredFavorites.length === 0 ? (
              <div className="text-center py-10 px-4 text-slate-500 text-xs space-y-2">
                <Star className="w-6 h-6 text-slate-700 mx-auto" />
                <p className="font-semibold text-slate-400">Немає обраних монет</p>
                <p className="text-[11px] text-slate-600">
                  Натисніть на зірочку біля монет у таблиці чи картці формацій, щоб вони з'явились тут.
                </p>
              </div>
            ) : (
              filteredFavorites.map((favCoin, idx) => {
                const isSelected = favCoin.symbol === activeCoin.symbol;
                const isFavPositive = favCoin.priceChange24h >= 0;
                return (
                  <div
                    key={`${favCoin.exchange}-${favCoin.symbol}-${favCoin.marketType}-${idx}`}
                    onClick={() => handleSelectFavoriteCoin(favCoin)}
                    className={`group p-2.5 rounded-xl border transition-all cursor-pointer flex items-center justify-between gap-2 ${
                      isSelected
                        ? 'bg-cyan-950/40 border-cyan-500/60 shadow-sm shadow-cyan-950/50'
                        : 'bg-slate-900/60 border-slate-800/80 hover:bg-slate-900 hover:border-slate-700'
                    }`}
                  >
                    <div className="flex flex-col min-w-0">
                      <div className="flex items-center gap-1.5">
                        <span className="font-mono font-bold text-xs text-white truncate">
                          {favCoin.baseAsset}/{favCoin.quoteAsset}
                        </span>
                        {isSelected && (
                          <span className="flex h-1.5 w-1.5 relative">
                            <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-cyan-400 opacity-75"></span>
                            <span className="relative inline-flex rounded-full h-1.5 w-1.5 bg-cyan-500"></span>
                          </span>
                        )}
                      </div>
                      <div className="flex items-center gap-1.5 mt-0.5">
                        <span className="text-[9px] uppercase font-bold px-1 rounded bg-slate-800 text-slate-400">
                          {favCoin.exchange}
                        </span>
                        <span className="text-[9px] uppercase font-semibold px-1 rounded bg-slate-800/80 text-slate-500">
                          {favCoin.marketType === 'futures' ? 'Fut' : 'Spot'}
                        </span>
                      </div>
                    </div>

                    <div className="flex items-center gap-2 shrink-0">
                      <div className="text-right">
                        {favCoin.currentPrice > 0 && (
                          <div className="font-mono text-xs font-semibold text-slate-200">
                            ${formatCryptoPrice(favCoin.currentPrice)}
                          </div>
                        )}
                        <div
                          className={`text-[10px] font-mono font-semibold ${
                            isFavPositive ? 'text-emerald-400' : 'text-rose-400'
                          }`}
                        >
                          {isFavPositive ? '+' : ''}
                          {favCoin.priceChange24h.toFixed(2)}%
                        </div>
                      </div>

                      <button
                        onClick={(e) => handleRemoveFromWatchlist(favCoin.symbol, e)}
                        className="p-1 rounded text-slate-600 hover:text-rose-400 hover:bg-rose-500/10 transition-colors"
                        title="Видалити з обраного"
                      >
                        <Trash2 className="w-3.5 h-3.5" />
                      </button>
                    </div>
                  </div>
                );
              })
            )}
          </div>
        </div>

       
        {/* Native HookChart replaces the external TradingView embed. */}
        <div className="w-full h-full min-h-0 flex flex-col p-2 sm:p-4">
          <TradingViewChart
            forceHookChart
            fullHeight
            klines={activeKlines}
            formation={formation}
            symbol={activeCoin.symbol}
            timeframe={timeframe}
            onTimeframeChange={handleTimeframeSelect}
            exchange={activeCoin.exchange}
            marketType={activeCoin.marketType}
            historyLimit={1000}
            onAddToArchive={onAddToArchive}
            isArchived={isArchived}
            customMarkers={visibleChartMarkers}
            previewMarkers={showEarlyLevels}
            hideSymbolAndPrice
            hideHeaderLiveIndicator
            hideHeaderFormationBadge
            onLiveStatusChange={setLiveStatus}
            onLivePriceUpdate={setChartLivePrice}
            onClosedCandle={earlyTouchRule && displayedEarlyCandidate && showEarlyLevels && timeframe === currentTimeframe
              ? closed => setLiveEarlyCandidate(previous =>
                  applyClosedEarlyWickTouch(previous ?? displayedEarlyCandidate,
                    closed, timeframe as Timeframe, earlyTouchRule))
              : undefined}
            savedChartParams={savedChartParams}
          />
        </div>
      </main>
    </div>
  );

  // Escape transformed, filtered and scrollable ancestors, including Safari modal containers.
  return typeof document === 'undefined' ? content : createPortal(content, document.body);
};
