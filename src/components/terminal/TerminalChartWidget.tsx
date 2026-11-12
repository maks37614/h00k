import React, { useState, useEffect, useRef, useMemo, useCallback } from 'react';
import {
  GripVertical,
  Trash2,
  Zap,
  Send,
  RefreshCw,
  ExternalLink,
  ChevronDown,
  Search,
  Sparkles,
  ArrowLeftRight,
  TrendingUp,
  TrendingDown,
  Columns,
  Eye,
  Activity,
  PanelLeftClose,
  PanelLeftOpen,
} from 'lucide-react';
import {
  TerminalChartBlock,
  ScannedCoin,
  DetectedFormation,
  ExchangeId,
  MarketType,
  Kline,
} from '../../types';
import { formatCryptoPrice, formatVolume } from '../../utils/formatters';
import { ExchangeCandlestickChart } from '../ExchangeCandlestickChart';
import type { TerminalToolbarVisibility } from '../hookchart/HookChartCanvas';
import { getTradingViewSymbol, normalizeExchangeSymbol } from '../../utils/marketSymbols';
import { fetchDirectKlines } from '../../utils/directExchangeClient';
import { useChartProvider } from '../../utils/useChartProvider';

interface TerminalChartWidgetProps {
  block: TerminalChartBlock;
  coin?: ScannedCoin;
  allCoins: ScannedCoin[];
  isSingleBlock: boolean;
  isMaximized: boolean;
  onToggleMaximize: () => void;
  onRemove: () => void;
  onUpdateBlock: (updated: Partial<TerminalChartBlock>) => void;
  onOpenFullscreenModal?: (coin: ScannedCoin, formation?: DetectedFormation) => void;
  onSendMetaScalp?: (coin: ScannedCoin) => void;
  metaScalpBinding?: string;
  onOpenTelegramAlerts?: (prefill?: any) => void;
  onDragStart?: (e: React.DragEvent) => void;
  onDragOver?: (e: React.DragEvent) => void;
  onDragLeave?: (e: React.DragEvent) => void;
  onDrop?: (e: React.DragEvent) => void;
  heightStyle?: string;
}


const calculatePearsonCorrelation = (left: number[], right: number[]): number | null => {
  const length = Math.min(left.length, right.length);
  if (length < 10) return null;

  const a = left.slice(-length);
  const b = right.slice(-length);
  const meanA = a.reduce((sum, value) => sum + value, 0) / length;
  const meanB = b.reduce((sum, value) => sum + value, 0) / length;

  let covariance = 0;
  let varianceA = 0;
  let varianceB = 0;

  for (let i = 0; i < length; i += 1) {
    const deltaA = a[i] - meanA;
    const deltaB = b[i] - meanB;
    covariance += deltaA * deltaB;
    varianceA += deltaA * deltaA;
    varianceB += deltaB * deltaB;
  }

  const denominator = Math.sqrt(varianceA * varianceB);
  if (!Number.isFinite(denominator) || denominator === 0) return null;

  return Math.max(-1, Math.min(1, covariance / denominator));
};

const calculateCorrelationToBtc = (assetKlines: Kline[], btcKlines: Kline[]): number | null => {
  const assetClosed = assetKlines.slice(0, -1);
  const btcClosed = btcKlines.slice(0, -1);
  if (assetClosed.length < 11 || btcClosed.length < 11) return null;

  const btcByTime = new Map(btcClosed.map((candle) => [candle.time, candle.close]));
  const aligned = assetClosed
    .map((candle) => {
      const btcClose = btcByTime.get(candle.time);
      return btcClose && candle.close > 0 && btcClose > 0
        ? { assetClose: candle.close, btcClose }
        : null;
    })
    .filter((item): item is { assetClose: number; btcClose: number } => item !== null)
    .slice(-51);

  if (aligned.length < 11) return null;

  const assetReturns: number[] = [];
  const btcReturns: number[] = [];

  for (let i = 1; i < aligned.length; i += 1) {
    assetReturns.push(Math.log(aligned[i].assetClose / aligned[i - 1].assetClose));
    btcReturns.push(Math.log(aligned[i].btcClose / aligned[i - 1].btcClose));
  }

  return calculatePearsonCorrelation(assetReturns, btcReturns);
};

const calculateAtrPercent = (klines: Kline[], period: number = 14): number | null => {
  const closed = klines.slice(0, -1);
  if (closed.length < period + 1) return null;

  const startIndex = closed.length - period;
  let trueRangeSum = 0;

  for (let i = startIndex; i < closed.length; i += 1) {
    const candle = closed[i];
    const previousClose = closed[i - 1]?.close ?? candle.open;
    const trueRange = Math.max(
      candle.high - candle.low,
      Math.abs(candle.high - previousClose),
      Math.abs(candle.low - previousClose)
    );
    trueRangeSum += trueRange;
  }

  const lastClose = closed[closed.length - 1]?.close;
  if (!lastClose || lastClose <= 0) return null;

  return (trueRangeSum / period / lastClose) * 100;
};

export const TerminalChartWidget: React.FC<TerminalChartWidgetProps> = ({
  block,
  coin,
  allCoins,
  isSingleBlock,
  isMaximized,
  onToggleMaximize,
  onRemove,
  onUpdateBlock,
  onOpenFullscreenModal,
  onSendMetaScalp,
  metaScalpBinding = '001',
  onOpenTelegramAlerts,
  onDragStart,
  onDragOver,
  onDragLeave,
  onDrop,
  heightStyle,
}) => {
  const chartProvider = useChartProvider();
  const useIntegratedHookChartToolbar = chartProvider === 'hookchart';
  // Coin switcher popup state
  const [isCoinPickerOpen, setIsCoinPickerOpen] = useState(false);
  const [coinSearch, setCoinSearch] = useState('');
  const [isSpanPickerOpen, setIsSpanPickerOpen] = useState(false);
  // Stable per-block state even when a distant chart temporarily unmounts.
  // Never synchronize open panels through profile, storage, or global events.
  const [extraToolsOpen, setExtraToolsOpen] = useState(false);
  const [drawingToolsOpen, setDrawingToolsOpen] = useState(false);
  const terminalToolbarVisibility = useMemo<TerminalToolbarVisibility>(() => ({
    extraToolsOpen,
    drawingToolsOpen,
    onExtraToolsOpenChange: setExtraToolsOpen,
    onDrawingToolsOpenChange: setDrawingToolsOpen,
  }), [extraToolsOpen, drawingToolsOpen]);
  const [showDrawingToolbar, setShowDrawingToolbar] = useState<boolean>(() => {
    try {
      const saved = localStorage.getItem('terminal_widget_show_toolbar');
      return saved !== null ? saved === 'true' : true;
    } catch {
      return true;
    }
  });
  const blockRootRef = useRef<HTMLDivElement>(null);
  const [isNearViewport, setIsNearViewport] = useState(isSingleBlock || isMaximized);
  const shouldLoadWidgets = isSingleBlock || isMaximized || isNearViewport;

  // Defer charts, feeds, and order books until their block is near the viewport.
  useEffect(() => {
    const node = blockRootRef.current;
    if (!node) return;
    if (typeof IntersectionObserver === 'undefined') {
      setIsNearViewport(true);
      return;
    }

    const observer = new IntersectionObserver(([entry]) => {
      setIsNearViewport(entry.isIntersecting);
    }, { rootMargin: '160px 0px' });
    observer.observe(node);
    return () => observer.disconnect();
  }, []);

  const handleToggleToolbar = useCallback(() => {
    setShowDrawingToolbar((prev) => {
      const next = !prev;
      try {
        localStorage.setItem('terminal_widget_show_toolbar', String(next));
      } catch {}
      return next;
    });
  }, []);

  const headerRef = useRef<HTMLDivElement>(null);
  const toolbarMenusRef = useRef<HTMLDivElement>(null);
  const toolbarScrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const toolbar = toolbarScrollRef.current;
    if (!toolbar) return;
    const handleWheel = (event: WheelEvent) => {
      if (event.ctrlKey || event.metaKey || toolbar.scrollWidth <= toolbar.clientWidth) return;
      const delta = Math.abs(event.deltaX) > Math.abs(event.deltaY) ? event.deltaX : event.deltaY;
      const unit = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? toolbar.clientWidth : 1;
      const previous = toolbar.scrollLeft;
      toolbar.scrollLeft += delta * unit;
      if (toolbar.scrollLeft !== previous) event.preventDefault();
    };
    toolbar.addEventListener('wheel', handleWheel, { passive: false });
    return () => toolbar.removeEventListener('wheel', handleWheel);
  }, []);

  useEffect(() => {
    if (!isCoinPickerOpen && !isSpanPickerOpen) return;
    const closeMenus = () => {
      setIsCoinPickerOpen(false);
      setIsSpanPickerOpen(false);
    };
    const handleClickOutside = (event: PointerEvent) => {
      if (!headerRef.current?.contains(event.target as Node) && !toolbarMenusRef.current?.contains(event.target as Node)) closeMenus();
    };
    const handleEscape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      closeMenus();
      event.stopPropagation();
    };
    document.addEventListener('pointerdown', handleClickOutside);
    document.addEventListener('keydown', handleEscape);
    return () => {
      document.removeEventListener('pointerdown', handleClickOutside);
      document.removeEventListener('keydown', handleEscape);
    };
  }, [isCoinPickerOpen, isSpanPickerOpen]);

  // Live prices for the order book and Telegram alerts
  const [currentPrice, setCurrentPrice] = useState<number | null>(coin?.currentPrice || null);
  const [livePrice, setLivePrice] = useState<number>(coin?.currentPrice || 0);
  const [timeframeMetrics, setTimeframeMetrics] = useState<{
    correlation: number | null;
    volatilityPct: number | null;
    loading: boolean;
  }>({
    correlation: null,
    volatilityPct: null,
    loading: true,
  });

  // Update when coin prop changes
  useEffect(() => {
    if (coin?.currentPrice) {
      setCurrentPrice(coin.currentPrice);
      setLivePrice(coin.currentPrice);
    }
  }, [coin?.currentPrice]);

  // Connect to lightweight real-time ticker stream
  useEffect(() => {
    if (!shouldLoadWidgets) return;
    let ws: WebSocket | null = null;
    let isDisposed = false;

    const cleanSymbol = normalizeExchangeSymbol(block.symbol);
    if (!cleanSymbol) return;

    const handlePriceUpdate = (price: number) => {
      if (isDisposed || !price || isNaN(price)) return;
      setCurrentPrice(price);
      setLivePrice(price);
    };

    if (block.exchange === 'binance') {
      const lower = encodeURIComponent(cleanSymbol.toLowerCase());
      const wsUrl =
        block.marketType === 'futures'
          ? `wss://fstream.binance.com/market/ws/${lower}@miniTicker`
          : `wss://stream.binance.com:9443/ws/${lower}@miniTicker`;

      try {
        ws = new WebSocket(wsUrl);
        ws.onmessage = (event) => {
          try {
            const data = JSON.parse(event.data);
            if (data && data.c) {
              const p = parseFloat(data.c);
              if (!isNaN(p)) handlePriceUpdate(p);
            }
          } catch {}
        };
      } catch {}
    } else {
      // Bybit
      const wsUrl =
        block.marketType === 'futures'
          ? 'wss://stream.bybit.com/v5/public/linear'
          : 'wss://stream.bybit.com/v5/public/spot';

      try {
        ws = new WebSocket(wsUrl);
        ws.onopen = () => {
          if (isDisposed) return;
          try {
            ws?.send(
              JSON.stringify({
                op: 'subscribe',
                args: [`tickers.${cleanSymbol}`],
              })
            );
          } catch {}
        };
        ws.onmessage = (event) => {
          try {
            const data = JSON.parse(event.data);
            if (data?.data) {
              const item = Array.isArray(data.data) ? data.data[0] : data.data;
              const p = parseFloat(item?.lastPrice);
              if (!isNaN(p)) handlePriceUpdate(p);
            }
          } catch {}
        };
      } catch {}
    }

    return () => {
      isDisposed = true;
      if (ws) {
        try {
          ws.close();
        } catch {}
      }
    };
  }, [block.symbol, block.exchange, block.marketType, shouldLoadWidgets]);

  // Correlation/ATR are only needed in TradingView's extra status strip.
  useEffect(() => {
    if (!shouldLoadWidgets || useIntegratedHookChartToolbar) return;
    let disposed = false;

    const loadTimeframeMetrics = async () => {
      setTimeframeMetrics((previous) => ({ ...previous, loading: true }));

      try {
        const symbol = normalizeExchangeSymbol(block.symbol);
        if (!symbol) {
          if (!disposed) {
            setTimeframeMetrics({ correlation: null, volatilityPct: null, loading: false });
          }
          return;
        }

        const assetKlinesPromise = fetchDirectKlines(
          block.exchange,
          block.marketType,
          symbol,
          block.timeframe,
          70
        );

        const [assetKlines, btcKlines] = symbol === 'BTCUSDT'
          ? await assetKlinesPromise.then((data) => [data, data] as const)
          : await Promise.all([
              assetKlinesPromise,
              fetchDirectKlines(
                block.exchange,
                block.marketType,
                'BTCUSDT',
                block.timeframe,
                70
              ),
            ]);

        if (disposed) return;

        setTimeframeMetrics({
          correlation: symbol === 'BTCUSDT' ? 1 : calculateCorrelationToBtc(assetKlines, btcKlines),
          volatilityPct: calculateAtrPercent(assetKlines),
          loading: false,
        });
      } catch {
        if (!disposed) {
          setTimeframeMetrics({ correlation: null, volatilityPct: null, loading: false });
        }
      }
    };

    void loadTimeframeMetrics();
    const refreshTimer = window.setInterval(() => {
      void loadTimeframeMetrics();
    }, 60_000);

    return () => {
      disposed = true;
      window.clearInterval(refreshTimer);
    };
  }, [block.symbol, block.exchange, block.marketType, block.timeframe, shouldLoadWidgets, useIntegratedHookChartToolbar]);

  const detailCoin = useMemo<ScannedCoin>(() => {
    if (coin) {
      return {
        ...coin,
        timeframe: block.timeframe,
        currentPrice: livePrice || coin.currentPrice,
      };
    }

    return {
      symbol: block.symbol,
      baseAsset: block.baseAsset,
      quoteAsset: block.quoteAsset,
      exchange: block.exchange,
      marketType: block.marketType,
      currentPrice: livePrice || currentPrice || 0,
      priceChange24h: 0,
      highPrice24h: 0,
      lowPrice24h: 0,
      volume24hUsd: 0,
      formations: [],
      timeframe: block.timeframe,
      lastUpdated: Date.now(),
      exchangeUrl: '',
    };
  }, [
    coin,
    block.symbol,
    block.baseAsset,
    block.quoteAsset,
    block.exchange,
    block.marketType,
    block.timeframe,
    livePrice,
    currentPrice,
  ]);

  // Active formation if any
  const activeFormation = useMemo(() => {
    if (!coin?.formations || coin.formations.length === 0) return null;
    if (block.formationId) {
      const match = coin.formations.find((f) => f.id === block.formationId);
      if (match) return match;
    }
    return coin.formations[0];
  }, [coin?.formations, block.formationId]);

  // Construct TradingView Embed URL
  const tradingViewUrl = useMemo(() => {
    if (chartProvider === 'hookchart') return null;
    const tvSymbol = getTradingViewSymbol(block.symbol, block.exchange, block.marketType);
    if (!tvSymbol) return null;

    let interval = '15';
    switch (block.timeframe) {
      case '1m': interval = '1'; break;
      case '5m': interval = '5'; break;
      case '15m': interval = '15'; break;
      case '1h': interval = '60'; break;
      case '4h': interval = '240'; break;
      case '1d': interval = 'D'; break;
      default: interval = '15';
    }

    const params = new URLSearchParams({
      symbol: tvSymbol,
      interval: interval,
      theme: 'dark',
      style: '1',
      timezone: 'exchange',
      withdateranges: '0',
      hide_top_toolbar: '1',
      hide_side_toolbar: '0',
      allow_symbol_change: '0',
      save_image: '0',
      hide_legend: '1',
      locale: 'uk',
      toolbar_bg: '#090d16',
      gridColor: 'rgba(0,0,0,0)',
      gridTransparency: '100',
    });

    return `https://s.tradingview.com/widgetembed/?${params.toString()}`;
  }, [chartProvider, block.symbol, block.exchange, block.marketType, block.timeframe]);
  // Embedded TradingView is reserved for a focused chart; grid cards use the lighter local chart.
  const shouldUseTradingViewEmbed = isSingleBlock || isMaximized;

  // Filtered coins for in-place switcher
  const filteredCoins = useMemo(() => {
    if (!coinSearch.trim()) return allCoins.slice(0, 30);
    const q = coinSearch.toLowerCase().trim();
    return allCoins
      .filter((c) => c.symbol.toLowerCase().includes(q) || c.baseAsset.toLowerCase().includes(q))
      .slice(0, 30);
  }, [allCoins, coinSearch]);

  // Compute CSS column span class
  const colSpanClass = useMemo(() => {
    if (isSingleBlock || isMaximized) return 'col-span-full';
    const effectiveSpan = block.colSpan || 1;
    switch (effectiveSpan) {
      case 2: return 'col-span-1 md:col-span-2';
      case 3: return 'col-span-1 md:col-span-2 lg:col-span-3';
      case 4:
      case 'full': return 'col-span-full';
      default: return 'col-span-1';
    }
  }, [block.colSpan, isSingleBlock, isMaximized]);

  const terminalToolbarControls = (
    <>
        {!isSingleBlock && !isMaximized && (
          <div
            className="terminal-chart-drag-handle rounded text-slate-500 hover:text-slate-300 cursor-grab active:cursor-grabbing hover:bg-slate-800/60"
            title="Перетягнути для зміни позиції"
          >
            <GripVertical className="w-3.5 h-3.5" />
          </div>
        )}
        <div
          ref={toolbarScrollRef}
          className="terminal-chart-toolbar-scroll min-w-0 flex-1 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-cyan-500/50"
          role="region"
          aria-label={`Інструменти графіка ${block.symbol}`}
          tabIndex={0}
        >
          <div className="terminal-chart-toolbar-row">
            {/* Coin, exchange, market and chart mode */}
            <div className="terminal-chart-toolbar-group flex items-center">
              {/* Coin Selector Dropdown trigger */}
              <div className="relative">
                <button
                  onClick={() => {
                    setIsCoinPickerOpen(current => !current);
                    setIsSpanPickerOpen(false);
                  }}
                  aria-expanded={isCoinPickerOpen}
                  className="flex items-center gap-1 px-1.5 py-0.5 rounded bg-slate-900 hover:bg-slate-800 font-mono font-bold text-white transition-colors cursor-pointer"
                  title="Змінити монету"
                >
                  <span>{block.symbol}</span>
                  <ChevronDown className="w-3 h-3 text-slate-400" />
                </button>
              </div>

              {/* Exchange badge (click to toggle exchange if available) */}
              <button
                onClick={() =>
                  onUpdateBlock({
                    exchange: block.exchange === 'binance' ? 'bybit' : 'binance',
                  })
                }
                className={`text-[9px] px-1.5 py-0.5 rounded font-bold uppercase cursor-pointer transition-colors ${
                  block.exchange === 'binance'
                    ? 'bg-amber-500/15 text-amber-300 hover:bg-amber-500/25'
                    : 'bg-orange-500/15 text-orange-300 hover:bg-orange-500/25'
                }`}
                title="Клікніть щоб змінити біржу (Binance / Bybit)"
              >
                {block.exchange}
              </button>

              {/* Market Type badge (Spot / Futures) */}
              <button
                onClick={() =>
                  onUpdateBlock({
                    marketType: block.marketType === 'futures' ? 'spot' : 'futures',
                  })
                }
                className="text-[9px] px-1.5 py-0.5 rounded bg-slate-900 hover:bg-slate-800 text-slate-400 uppercase cursor-pointer"
                title="Клікніть щоб змінити тип ринку (Perp / Spot)"
              >
                {block.marketType === 'futures' ? 'Perp' : 'Spot'}
              </button>

            </div>
            {/* Chart tools */}
            <div className="terminal-chart-toolbar-group ml-auto flex items-center">
              {/* MetaScalp send button */}
              {coin && onSendMetaScalp && (
                <button
                  onClick={() => onSendMetaScalp(coin)}
                  className="p-1 rounded bg-amber-500/10 hover:bg-amber-500/20 text-amber-300 transition-colors"
                  title={`Надіслати в MetaScalp (${metaScalpBinding})`}
                >
                  <Zap className="w-3 h-3 text-amber-400" />
                </button>
              )}

              {/* Telegram Alert quick button */}
              {coin && onOpenTelegramAlerts && (
                <button
                  onClick={() =>
                    onOpenTelegramAlerts({
                      symbol: coin.symbol,
                      exchange: coin.exchange,
                      marketType: coin.marketType,
                      currentPrice: livePrice,
                      targetPrice: activeFormation?.levels?.targetPrice,
                      formationName: activeFormation?.name,
                    })
                  }
                  className="p-1 rounded bg-sky-500/10 hover:bg-sky-500/20 text-sky-300 transition-colors"
                  title="Налаштувати алерт у Telegram"
                >
                  <Send className="w-3 h-3 text-sky-400" />
                </button>
              )}

              {/* Col Span & Height Adjuster (Width & Height) */}
              {!isSingleBlock && !isMaximized && (
                <div className="relative">
                  <button
                    onClick={() => {
                      setIsSpanPickerOpen(current => !current);
                      setIsCoinPickerOpen(false);
                    }}
                    aria-expanded={isSpanPickerOpen}
                    className={`p-1 rounded transition-colors cursor-pointer ${
                      isSpanPickerOpen
                        ? 'bg-cyan-500/20 text-cyan-300'
                        : 'text-slate-400 hover:text-white hover:bg-slate-800'
                    }`}
                    title="Ширина та висота блоку (1, 2, 3 колонки, висота)"
                  >
                    <Columns className="w-3 h-3" />
                  </button>
                </div>
              )}
            </div>
          </div>
        </div>
        <div className="terminal-chart-header-actions flex shrink-0 items-center gap-1">
          {/* Detailed chart / extended analysis */}
          {onOpenFullscreenModal && (
            <button
              type="button"
              onClick={() => onOpenFullscreenModal(detailCoin, activeFormation || undefined)}
              className="p-1 rounded text-slate-400 hover:text-cyan-300 hover:bg-slate-800 transition-colors cursor-pointer"
              title="Відкрити детальний графік з розширеним аналізом"
              aria-label="Відкрити детальний графік з розширеним аналізом"
            >
              <ExternalLink className="w-3 h-3" />
            </button>
          )}

          {/* Remove / Close Block button */}
          <button
            onClick={onRemove}
            className="p-1 rounded text-slate-400 hover:text-rose-400 hover:bg-rose-950/40 transition-colors"
            title="Закрити графік"
          >
            <Trash2 className="w-3 h-3" />
          </button>
        </div>
    </>
  );
  const terminalToolbarMenus = (
    <>
        {/* In-place Coin Switcher Popover */}
        {isCoinPickerOpen && (
          <div
            className="terminal-chart-header-popover absolute left-2 top-full mt-1.5 z-40 w-64 bg-slate-900 border border-slate-700 rounded-xl shadow-2xl overflow-hidden animate-in fade-in"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="p-2 border-b border-slate-800 bg-slate-950">
              <div className="relative">
                <Search className="w-3.5 h-3.5 absolute left-2 top-1/2 -translate-y-1/2 text-slate-400" />
                <input
                  type="text"
                  value={coinSearch}
                  onChange={(e) => setCoinSearch(e.target.value)}
                  placeholder="Швидкий пошук..."
                  autoFocus
                  className="w-full pl-7 pr-2 py-1 bg-slate-900 border border-slate-700 rounded-lg text-xs text-white placeholder-slate-500 focus:outline-none focus:border-cyan-500"
                />
              </div>
            </div>
            <div className="terminal-chart-coin-list max-h-48 overflow-y-auto divide-y divide-slate-800/60 p-1">
              {filteredCoins.map((c) => (
                <button
                  key={`${c.exchange}-${c.symbol}`}
                  onClick={() => {
                    onUpdateBlock({
                      symbol: c.symbol,
                      baseAsset: c.baseAsset,
                      quoteAsset: c.quoteAsset,
                      exchange: c.exchange,
                      marketType: c.marketType,
                      formationId: c.formations?.[0]?.id,
                    });
                    setIsCoinPickerOpen(false);
                  }}
                  className="w-full text-left px-2 py-1.5 rounded-lg hover:bg-slate-800 flex items-center justify-between text-xs transition-colors"
                >
                  <div className="flex items-center gap-1.5">
                    <span className="font-mono font-bold text-white">{c.symbol}</span>
                    <span className="text-[9px] px-1 rounded bg-slate-800 text-slate-400 uppercase">
                      {c.exchange}
                    </span>
                  </div>
                  <span className="font-mono text-[11px] text-slate-300">
                    ${formatCryptoPrice(c.currentPrice)}
                  </span>
                </button>
              ))}
            </div>
          </div>
        )}
        {isSpanPickerOpen && (
          <div
            className="terminal-chart-header-popover absolute right-2 top-full mt-1 z-40 bg-slate-900 border border-slate-700 rounded-xl p-1 shadow-xl flex flex-col gap-0.5 text-[11px] w-max"
            onClick={(e) => e.stopPropagation()}
          >
            <button
              onClick={() => {
                onUpdateBlock({ colSpan: 1 });
                setIsSpanPickerOpen(false);
              }}
              className={`px-2 py-1 rounded text-left hover:bg-slate-800 ${
                block.colSpan === 1 || !block.colSpan ? 'text-cyan-300 font-bold' : 'text-slate-300'
              }`}
            >
              1 колонка (Стандарт)
            </button>
            <button
              onClick={() => {
                onUpdateBlock({ colSpan: 2 });
                setIsSpanPickerOpen(false);
              }}
              className={`px-2 py-1 rounded text-left hover:bg-slate-800 ${
                block.colSpan === 2 ? 'text-cyan-300 font-bold' : 'text-slate-300'
              }`}
            >
              2 колонки (Широкий)
            </button>
            <button
              onClick={() => {
                onUpdateBlock({ colSpan: 3 });
                setIsSpanPickerOpen(false);
              }}
              className={`px-2 py-1 rounded text-left hover:bg-slate-800 ${
                block.colSpan === 3 ? 'text-cyan-300 font-bold' : 'text-slate-300'
              }`}
            >
              3 колонки (Дуже широкий)
            </button>
            <button
              onClick={() => {
                onUpdateBlock({ colSpan: 'full' });
                setIsSpanPickerOpen(false);
              }}
              className={`px-2 py-1 rounded text-left hover:bg-slate-800 ${
                block.colSpan === 'full' ? 'text-cyan-300 font-bold' : 'text-slate-300'
              }`}
            >
              Повна ширина
            </button>
            <div className="my-1 border-t border-slate-800" />
            <div className="px-2 pt-1 text-[10px] font-bold uppercase tracking-wide text-slate-500">
              Висота графіка
            </div>
            {[
              { px: 280, label: 'Мінімум' },
              { px: 380, label: 'Компактний' },
              { px: 480, label: 'Стандартний' },
              { px: 620, label: 'Високий' },
            ].map((height) => (
              <button
                key={height.px}
                onClick={() => {
                  onUpdateBlock({ heightPx: height.px });
                  setIsSpanPickerOpen(false);
                }}
                className={`px-2 py-1 rounded text-left hover:bg-slate-800 ${
                  block.heightPx === height.px ? 'text-cyan-300 font-bold' : 'text-slate-300'
                }`}
              >
                {height.label}
              </button>
            ))}
            <button
              onClick={() => {
                onUpdateBlock({ heightPx: undefined });
                setIsSpanPickerOpen(false);
              }}
              className="px-2 py-1 rounded text-left text-slate-400 hover:bg-slate-800 hover:text-slate-200"
            >
              Автоматична висота
            </button>
          </div>
        )}
    </>
  );

  return (
    <div
      ref={blockRootRef}
      draggable={!isSingleBlock && !isMaximized}
      onDragStart={onDragStart}
      onDragOver={onDragOver}
      onDragLeave={onDragLeave}
      onDrop={onDrop}
      className={`terminal-chart-block relative flex min-w-0 flex-col bg-[#090d16] overflow-hidden transition-all duration-150 ${useIntegratedHookChartToolbar ? 'terminal-chart-hookchart border-0 rounded-none shadow-none' : 'border border-slate-800 rounded-xl shadow-lg'} ${colSpanClass} ${
        isMaximized ? 'fixed inset-2 sm:inset-4 z-50 rounded-2xl border-cyan-500/50 shadow-2xl shadow-cyan-950/50' : ''
      }`}
      style={{
        height: isMaximized
          ? 'calc(100vh - 2rem)'
          : block.heightPx
          ? `${block.heightPx}px`
          : heightStyle || undefined,
        minHeight: isSingleBlock || isMaximized
          ? '420px'
          : '300px',
      }}
    >
      {/* TradingView keeps its original standalone header; HookChart uses the chart toolbar. */}
      {!useIntegratedHookChartToolbar && (
        <div ref={headerRef} className="terminal-chart-header relative flex items-center gap-1.5 px-2 py-1.5 bg-slate-950 border-b border-slate-800/90 text-xs shrink-0 select-none">
          {terminalToolbarControls}
          {terminalToolbarMenus}
        </div>
      )}

      {/* Chart body */}
      <div className="flex-1 w-full relative bg-[#090d16] overflow-hidden min-h-0 flex flex-col">
        {shouldLoadWidgets ? (
          <div className="flex-1 w-full h-full relative overflow-hidden bg-[#090d16]">
            {tradingViewUrl && shouldUseTradingViewEmbed ? (
              <>
                <div
                  className={`absolute top-0 h-full transition-[width,left] duration-200 ease-in-out ${
                    showDrawingToolbar ? 'left-0 w-full' : '-left-[54px] w-[calc(100%+54px)]'
                  }`}
                >
                  <iframe
                    key={`tv-${block.symbol}-${block.exchange}-${block.marketType}-${block.timeframe}`}
                    src={tradingViewUrl}
                    className="w-full h-full border-0"
                    title={`${block.symbol} TradingView Chart`}
                    loading="lazy"
                    allowFullScreen
                  />
                </div>

                <div className="absolute bottom-2 left-2 z-20 flex items-center gap-1.5">
                  <button
                    type="button"
                    onClick={handleToggleToolbar}
                    className="flex h-7 w-7 items-center justify-center bg-transparent border-0 text-slate-300 hover:text-cyan-300 shadow-none transition-colors cursor-pointer group"
                    title={showDrawingToolbar ? 'Сховати панель інструментів' : 'Показати панель інструментів'}
                    aria-label={showDrawingToolbar ? 'Сховати панель інструментів' : 'Показати панель інструментів'}
                  >
                    {showDrawingToolbar ? (
                      <PanelLeftClose className="h-3.5 w-3.5 group-hover:scale-110 transition-transform" />
                    ) : (
                      <PanelLeftOpen className="h-3.5 w-3.5 group-hover:scale-110 transition-transform" />
                    )}
                  </button>
                </div>
              </>
            ) : (
              <ExchangeCandlestickChart
                terminalMode={useIntegratedHookChartToolbar}
                terminalToolbarVisibility={useIntegratedHookChartToolbar ? terminalToolbarVisibility : undefined}
                onTimeframeChange={useIntegratedHookChartToolbar ? (nextTimeframe) => onUpdateBlock({ timeframe: nextTimeframe }) : undefined}
                hookchartToolbarActions={useIntegratedHookChartToolbar ? (
                  <div ref={headerRef} className="terminal-chart-header terminal-chart-integrated-toolbar flex items-center gap-1.5 text-xs select-none">
                    {terminalToolbarControls}
                  </div>
                ) : undefined}
                hookchartToolbarOverlays={useIntegratedHookChartToolbar ? (
                  <div ref={toolbarMenusRef} className="terminal-chart-integrated-menus">
                    {terminalToolbarMenus}
                  </div>
                ) : undefined}
                formation={chartProvider === 'hookchart' && coin?.timeframe === block.timeframe ? activeFormation : undefined}
                symbol={block.symbol}
                exchange={block.exchange}
                marketType={block.marketType}
                timeframe={block.timeframe}
                historyLimit={isMaximized || isSingleBlock ? 1000 : 180}
              />
            )}
          </div>
        ) : (
          <div className="flex flex-1 min-h-0 flex-col items-center justify-center gap-2 px-4 text-center text-slate-500">
            <span className="font-mono text-sm font-semibold text-slate-300">{block.symbol}</span>
            <span className="text-xs">Віджет призупинено поза видимою областю. Прокрутіть до блока, щоб завантажити його.</span>
          </div>
        )}
      </div>

      {/* HookChart already shows market statistics in its own footer. */}
      {!useIntegratedHookChartToolbar && (
      <div className="px-2 py-0.5 bg-slate-950/80 border-t border-slate-800/60 text-[10px] text-slate-400 flex items-center justify-between font-mono shrink-0 select-none">
        <div className="flex items-center gap-2">
          {coin?.volume24hUsd && (
            <span>
              Vol 24г: <span className="text-slate-200">{formatVolume(coin.volume24hUsd)}</span>
            </span>
          )}
          <span
            className="hidden sm:inline"
            title={`Кореляція доходностей ${block.symbol} до BTCUSDT за останніми закритими свічками (${block.timeframe})`}
          >
            Corr:{' '}
            <span className="text-cyan-300">
              {timeframeMetrics.loading
                ? '…'
                : timeframeMetrics.correlation !== null
                ? timeframeMetrics.correlation.toFixed(2)
                : '—'}
            </span>
          </span>
          <span
            className="hidden sm:inline"
            title={`Волатильність ATR(14) на таймфреймі ${block.timeframe}`}
          >
            Vol:{' '}
            <span className="text-amber-300">
              {timeframeMetrics.loading
                ? '…'
                : timeframeMetrics.volatilityPct !== null
                ? `${timeframeMetrics.volatilityPct.toFixed(2)}%`
                : '—'}
            </span>
          </span>
        </div>

        <div className="flex items-center gap-1.5 text-slate-500" title={shouldLoadWidgets ? 'Віджет оновлюється' : 'Оновлення призупинено поза екраном'}>
          <span className={`w-1.5 h-1.5 rounded-full ${shouldLoadWidgets ? 'bg-emerald-500 animate-pulse' : 'bg-slate-600'}`} />
          <span className="text-[9px] uppercase tracking-wider text-slate-400">{shouldLoadWidgets ? 'Live' : 'Пауза'}</span>
        </div>
      </div>
      )}
    </div>
  );
};

