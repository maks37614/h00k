import { HookChart } from '../HookChart';
import type { HookChartHandle } from '../hookchart/engine';
import { useChartProvider } from '../../utils/useChartProvider';
import { replayChartMarkers } from '../../utils/hookchartData';
import React, { useEffect, useRef, useState, useCallback, useImperativeHandle, forwardRef, useMemo } from 'react';
import {
  createChart,
  CandlestickSeries,
  HistogramSeries,
  IChartApi,
  ISeriesApi,
  Time,
  LineStyle,
  IPriceLine,
  CrosshairMode,
} from 'lightweight-charts';
import { Kline, Timeframe, ExchangeId, MarketType, ReplayPosition, ReplayPendingOrder } from '../../types';
import { getChartPriceFormat, formatCryptoPrice } from '../../utils/formatters';
import { Maximize2, Minimize2, RotateCcw, Camera } from 'lucide-react';
import { requestFullscreenSafe, exitFullscreenSafe, isCurrentlyFullscreen } from '../../utils/fullscreenUtils';
import { createPortal } from 'react-dom';

/** Visible viewport, including offset while mobile browser chrome/zoom changes. */
const readViewport = () => ({
  width: typeof window === 'undefined' ? 1024 : Math.max(1, Math.round(window.visualViewport?.width || window.innerWidth)),
  height: typeof window === 'undefined' ? 760 : Math.max(1, Math.round(window.visualViewport?.height || window.innerHeight)),
  offsetLeft: typeof window === 'undefined' ? 0 : (window.visualViewport?.offsetLeft || 0),
  offsetTop: typeof window === 'undefined' ? 0 : (window.visualViewport?.offsetTop || 0),
});

export interface ReplayChartHandle {
  takeScreenshot: () => string | null;
  fitContent: () => void;
  zoomToLatest: () => void;
}

interface ReplayChartProps {
  visibleCandles: Kline[];
  symbol: string;
  timeframe: Timeframe;
  onTimeframeChange: (timeframe: Timeframe) => void;
  isLoadingHistoricalData?: boolean;
  exchange: ExchangeId;
  marketType: MarketType;
  position: ReplayPosition | null;
  pendingOrders: ReplayPendingOrder[];
  isReplaying: boolean;
  focusTrigger?: number;
  onTakeScreenshotNotification?: () => void;
}

export const ReplayChart = forwardRef<ReplayChartHandle, ReplayChartProps>(({
  visibleCandles,
  symbol,
  timeframe,
  onTimeframeChange,
  isLoadingHistoricalData = false,
  exchange,
  marketType,
  position,
  pendingOrders,
  isReplaying,
  focusTrigger = 0,
  onTakeScreenshotNotification,
}, ref) => {
  const chartProvider = useChartProvider();
  const hookChartRef = useRef<HookChartHandle | null>(null);
  const hookMarkers = useMemo(() => replayChartMarkers(position, pendingOrders).filter(marker => marker.id !== 'liquidation'), [position, pendingOrders]);
  const chartContainerRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const candleSeriesRef = useRef<ISeriesApi<'Candlestick'> | null>(null);
  const volumeSeriesRef = useRef<ISeriesApi<'Histogram'> | null>(null);

  // The outer Replay chart block always fills its own responsive container.
  const [viewport, setViewport] = useState(readViewport);
  const fullscreenRootRef = useRef<HTMLDivElement>(null);
  const nativeFullscreenRef = useRef(false);

  useEffect(() => {
    const syncViewport = () => {
      const next = readViewport();
      setViewport(current =>
        current.width === next.width && current.height === next.height &&
        current.offsetLeft === next.offsetLeft && current.offsetTop === next.offsetTop
          ? current : next);
    };
    syncViewport();
    window.addEventListener('resize', syncViewport);
    window.addEventListener('orientationchange', syncViewport);
    window.visualViewport?.addEventListener('resize', syncViewport);
    window.visualViewport?.addEventListener('scroll', syncViewport);
    return () => {
      window.removeEventListener('resize', syncViewport);
      window.removeEventListener('orientationchange', syncViewport);
      window.visualViewport?.removeEventListener('resize', syncViewport);
      window.visualViewport?.removeEventListener('scroll', syncViewport);
    };
  }, []);

  // Price lines refs
  const entryLineRef = useRef<IPriceLine | null>(null);
  const slLineRef = useRef<IPriceLine | null>(null);
  const tpLineRef = useRef<IPriceLine | null>(null);
  const pendingLinesRef = useRef<IPriceLine[]>([]);

  // Hovered or active candle state for tooltip
  const [activeCandle, setActiveCandle] = useState<Kline | null>(null);
  const [isFullscreen, setIsFullscreen] = useState(false);
  // Like Screener fullscreen: always occupy the viewport, without resize handles.
  // Native fullscreen escapes transformed ancestors; the fixed overlay is a fallback.
  const closeFullscreen = useCallback(async () => {
    if (nativeFullscreenRef.current) {
      await exitFullscreenSafe();
      nativeFullscreenRef.current = false;
    }
    setIsFullscreen(false);
  }, []);

  const toggleFullscreen = useCallback(async () => {
    if (isFullscreen) {
      await closeFullscreen();
      return;
    }
    const root = fullscreenRootRef.current;
    if (!root) return;
    nativeFullscreenRef.current = await requestFullscreenSafe(root);
    setIsFullscreen(true);
  }, [isFullscreen, closeFullscreen]);

  useEffect(() => {
    const onNativeFullscreenChange = () => {
      if (nativeFullscreenRef.current && !isCurrentlyFullscreen()) {
        nativeFullscreenRef.current = false;
        setIsFullscreen(false);
      }
    };
    document.addEventListener('fullscreenchange', onNativeFullscreenChange);
    document.addEventListener('webkitfullscreenchange', onNativeFullscreenChange);
    return () => {
      document.removeEventListener('fullscreenchange', onNativeFullscreenChange);
      document.removeEventListener('webkitfullscreenchange', onNativeFullscreenChange);
    };
  }, []);

  // Keep the original page position when mobile Safari uses the body portal
  // fallback. Lock scrolling before paint, and restore it on exit.
  React.useLayoutEffect(() => {
    if (!isFullscreen) return;
    const scrollX = window.scrollX;
    const scrollY = window.scrollY;
    const body = document.body;
    const html = document.documentElement;
    const old = {
      bodyOverflow: body.style.overflow,
      bodyPosition: body.style.position,
      bodyTop: body.style.top,
      bodyLeft: body.style.left,
      bodyWidth: body.style.width,
      htmlOverflow: html.style.overflow,
    };
    html.style.overflow = 'hidden';
    body.style.overflow = 'hidden';
    if (!nativeFullscreenRef.current) {
      body.style.position = 'fixed';
      body.style.top = `-${scrollY}px`;
      body.style.left = `-${scrollX}px`;
      body.style.width = '100%';
    }
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !nativeFullscreenRef.current) {
        event.preventDefault();
        setIsFullscreen(false);
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => {
      window.removeEventListener('keydown', onKeyDown);
      body.style.overflow = old.bodyOverflow;
      body.style.position = old.bodyPosition;
      body.style.top = old.bodyTop;
      body.style.left = old.bodyLeft;
      body.style.width = old.bodyWidth;
      html.style.overflow = old.htmlOverflow;
      if (!nativeFullscreenRef.current) window.scrollTo(scrollX, scrollY);
    };
  }, [isFullscreen]);

  const [isFocusedBadge, setIsFocusedBadge] = useState(false);

  // Helper to center/focus on candles with optimal spacing
  const focusOnCandles = useCallback((scrollIntoView = false) => {
    if (chartProvider === 'hookchart') { hookChartRef.current?.zoomToLatest(); return; }
    if (!chartRef.current || visibleCandles.length === 0) return;
    const total = visibleCandles.length;
    const visibleBars = Math.min(65, total);

    // Set visible logical range focused on recent cutoff candles + 16 bars of forward breathing room
    chartRef.current.timeScale().setVisibleLogicalRange({
      from: Math.max(0, total - visibleBars),
      to: total + 16,
    });

    if (scrollIntoView && chartContainerRef.current) {
      chartContainerRef.current.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    }

    // Flash a brief focus confirmation badge
    setIsFocusedBadge(true);
    setTimeout(() => setIsFocusedBadge(false), 2400);
  }, [visibleCandles.length, chartProvider]);

  // Capture canvas screenshot
  const captureScreenshot = useCallback((): string | null => {
    try {
      if (chartProvider === 'hookchart') return hookChartRef.current?.takeScreenshot() || null;
      if (chartRef.current) {
        // Lightweight-charts native screenshot
        const screenshotCanvas = chartRef.current.takeScreenshot();
        if (screenshotCanvas) {
          return screenshotCanvas.toDataURL('image/png');
        }
      }
      if (chartContainerRef.current) {
        const canvas = chartContainerRef.current.querySelector('canvas');
        if (canvas) {
          return canvas.toDataURL('image/png');
        }
      }
    } catch (e) {
      console.warn('Failed to capture screenshot:', e);
    }
    return null;
  }, [chartProvider]);

  useImperativeHandle(ref, () => ({
    takeScreenshot: captureScreenshot,
    fitContent: () => {
      if (chartProvider === 'hookchart') { hookChartRef.current?.fitContent(); return; }
      chartRef.current?.timeScale().fitContent();
    },
    zoomToLatest: () => {
      if (chartProvider === 'hookchart') { hookChartRef.current?.zoomToLatest(); return; }
      if (chartRef.current && visibleCandles.length > 0) {
        const total = visibleCandles.length;
        const visible = Math.min(80, total);
        chartRef.current.timeScale().setVisibleLogicalRange({
          from: total - visible,
          to: total + 4,
        });
      }
    },
  }), [captureScreenshot, visibleCandles.length, chartProvider]);

  // Set latest candle as active candle when visible candles change
  useEffect(() => {
    if (visibleCandles.length > 0) {
      const latest = visibleCandles[visibleCandles.length - 1];
      setActiveCandle(latest);
    }
  }, [visibleCandles]);

  // Initialize the selected chart renderer.
  useEffect(() => {
    if (chartProvider === 'hookchart' || !chartContainerRef.current) return;

    chartContainerRef.current.innerHTML = '';

    const chart = createChart(chartContainerRef.current, {
      layout: {
        background: { color: '#090d16' },
        textColor: '#94a3b8',
        fontSize: 11,
        fontFamily: 'JetBrains Mono, monospace, -apple-system, BlinkMacSystemFont',
      },
      grid: {
        vertLines: { color: 'rgba(30, 41, 59, 0.45)', style: LineStyle.Dotted },
        horzLines: { color: 'rgba(30, 41, 59, 0.45)', style: LineStyle.Dotted },
      },
      crosshair: {
        mode: CrosshairMode.Normal,
        vertLine: {
          color: '#38bdf8',
          width: 1,
          style: LineStyle.Dashed,
          labelBackgroundColor: '#0284c7',
        },
        horzLine: {
          color: '#38bdf8',
          width: 1,
          style: LineStyle.Dashed,
          labelBackgroundColor: '#0284c7',
        },
      },
      rightPriceScale: {
        borderColor: '#1e293b',
        scaleMargins: {
          top: 0.08,
          bottom: 0.18,
        },
        autoScale: true,
      },
      timeScale: {
        borderColor: '#1e293b',
        timeVisible: true,
        secondsVisible: false,
        barSpacing: 8,
        minBarSpacing: 3,
        rightOffset: 8,
      },
      handleScale: {
        mouseWheel: true,
        pinch: true,
        axisPressedMouseMove: true,
      },
      handleScroll: {
        mouseWheel: true,
        pressedMouseMove: true,
        horzTouchDrag: true,
        vertTouchDrag: true,
      },
    });

    // Remove watermark/logo if any
    const logo = chartContainerRef.current.querySelector('#tv-attr-logo');
    if (logo) logo.remove();

    const samplePrice = visibleCandles[visibleCandles.length - 1]?.close || 100;
    const priceFormat = getChartPriceFormat(samplePrice);

    // Candlestick Series
    const candleSeries = chart.addSeries(CandlestickSeries, {
      upColor: '#10b981',
      downColor: '#ef4444',
      borderUpColor: '#10b981',
      borderDownColor: '#ef4444',
      wickUpColor: '#10b981',
      wickDownColor: '#ef4444',
      priceFormat,
    });

    // Volume Histogram Series
    const volumeSeries = chart.addSeries(HistogramSeries, {
      priceFormat: {
        type: 'volume',
      },
      priceScaleId: '', // overlay
    });
    chart.priceScale('').applyOptions({
      scaleMargins: {
        top: 0.82,
        bottom: 0,
      },
    });

    chartRef.current = chart;
    candleSeriesRef.current = candleSeries;
    volumeSeriesRef.current = volumeSeries;

    // Crosshair move handler to update candle info display
    chart.subscribeCrosshairMove((param) => {
      if (!param.time || !param.seriesData) {
        if (visibleCandles.length > 0) {
          setActiveCandle(visibleCandles[visibleCandles.length - 1]);
        }
        return;
      }
      const data = param.seriesData.get(candleSeries) as any;
      if (data && data.open !== undefined) {
        setActiveCandle({
          time: Number(param.time),
          open: data.open,
          high: data.high,
          low: data.low,
          close: data.close,
          volume: 0,
        });
      }
    });

    // Handle responsive resize
    let resizeTimer: any;
    const handleResize = () => {
      clearTimeout(resizeTimer);
      resizeTimer = setTimeout(() => {
        if (chartRef.current && chartContainerRef.current) {
          const w = chartContainerRef.current.clientWidth;
          const h = chartContainerRef.current.clientHeight;
          if (w > 0 && h > 0) {
            chartRef.current.resize(w, h);
          }
        }
      }, 50);
    };

    const resizeObserver = new ResizeObserver(handleResize);
    resizeObserver.observe(chartContainerRef.current);

    return () => {
      resizeObserver.disconnect();
      clearTimeout(resizeTimer);
      chart.remove();
      chartRef.current = null;
      candleSeriesRef.current = null;
      volumeSeriesRef.current = null;
      entryLineRef.current = null;
      slLineRef.current = null;
      tpLineRef.current = null;
      pendingLinesRef.current = [];
    };
  }, [chartProvider]);

  // Update data when visibleCandles change
  useEffect(() => {
    if (!candleSeriesRef.current || !volumeSeriesRef.current) return;
    if (visibleCandles.length === 0) return;

    const candleData = visibleCandles.map((c) => ({
      time: c.time as Time,
      open: c.open,
      high: c.high,
      low: c.low,
      close: c.close,
    }));

    const volumeData = visibleCandles.map((c) => ({
      time: c.time as Time,
      value: c.volume,
      color: c.close >= c.open ? 'rgba(16, 185, 129, 0.35)' : 'rgba(239, 68, 68, 0.35)',
    }));

    candleSeriesRef.current.setData(candleData);
    volumeSeriesRef.current.setData(volumeData);
  }, [visibleCandles, chartProvider]);

  const focusOnCandlesRef = useRef(focusOnCandles);
  useEffect(() => {
    focusOnCandlesRef.current = focusOnCandles;
  }, [focusOnCandles]);

  // Auto-focus on candles whenever a new date/coin is loaded (focusTrigger increments)
  useEffect(() => {
    if (visibleCandles.length === 0) return;
    const timer = setTimeout(() => {
      focusOnCandlesRef.current(true);
    }, 80);
    return () => clearTimeout(timer);
  }, [focusTrigger]);

  // Replay playback auto-follow: ensure newly stepped-in candles stay comfortably inside visible range
  useEffect(() => {
    if (!chartRef.current || visibleCandles.length === 0) return;
    const total = visibleCandles.length;
    const timeScale = chartRef.current.timeScale();
    const logicalRange = timeScale.getVisibleLogicalRange();

    if (logicalRange) {
      // If candle moves past the visible right edge or within 4 bars of it, scroll forward smoothly
      if (total >= logicalRange.to - 4) {
        const barSpan = Math.max(30, logicalRange.to - logicalRange.from);
        timeScale.setVisibleLogicalRange({
          from: total - Math.round(barSpan * 0.75),
          to: total + Math.round(barSpan * 0.25),
        });
      }
    }
  }, [visibleCandles.length]);

  // Update Position Price Lines (Entry, SL, TP, Liquidation)
  useEffect(() => {
    if (!candleSeriesRef.current) return;

    // Clean up old lines
    if (entryLineRef.current) {
      candleSeriesRef.current.removePriceLine(entryLineRef.current);
      entryLineRef.current = null;
    }
    if (slLineRef.current) {
      candleSeriesRef.current.removePriceLine(slLineRef.current);
      slLineRef.current = null;
    }
    if (tpLineRef.current) {
      candleSeriesRef.current.removePriceLine(tpLineRef.current);
      tpLineRef.current = null;
    }

    if (position) {
      // Entry Line
      entryLineRef.current = candleSeriesRef.current.createPriceLine({
        price: position.entryPrice,
        color: position.side === 'long' ? '#10b981' : '#f43f5e',
        lineWidth: 2,
        lineStyle: LineStyle.Solid,
        axisLabelVisible: true,
        title: `Вхід ${position.side.toUpperCase()}: ${formatCryptoPrice(position.entryPrice)}`,
      });

      // SL Line
      if (position.slPrice && position.slPrice > 0) {
        slLineRef.current = candleSeriesRef.current.createPriceLine({
          price: position.slPrice,
          color: '#ef4444',
          lineWidth: 2,
          lineStyle: LineStyle.Dashed,
          axisLabelVisible: true,
          title: `Stop-Loss: ${formatCryptoPrice(position.slPrice)}`,
        });
      }

      // TP Line
      if (position.tpPrice && position.tpPrice > 0) {
        tpLineRef.current = candleSeriesRef.current.createPriceLine({
          price: position.tpPrice,
          color: '#10b981',
          lineWidth: 2,
          lineStyle: LineStyle.Dashed,
          axisLabelVisible: true,
          title: `Take-Profit: ${formatCryptoPrice(position.tpPrice)}`,
        });
      }

    }
  }, [position, chartProvider]);

  // Update Pending Orders Lines
  useEffect(() => {
    if (!candleSeriesRef.current) return;

    // Remove existing pending lines
    for (const line of pendingLinesRef.current) {
      candleSeriesRef.current.removePriceLine(line);
    }
    pendingLinesRef.current = [];

    // Add new lines for pending limit / stop orders
    for (const order of pendingOrders) {
      const line = candleSeriesRef.current.createPriceLine({
        price: order.price,
        color: '#f59e0b',
        lineWidth: 1,
        lineStyle: LineStyle.Dotted,
        axisLabelVisible: true,
        title: `${order.orderType.toUpperCase()} ${order.side.toUpperCase()}: ${formatCryptoPrice(order.price)}`,
      });
      pendingLinesRef.current.push(line);
    }
  }, [pendingOrders, chartProvider]);

  const latestCandle = visibleCandles[visibleCandles.length - 1] || null;
  const displayCandle = activeCandle || latestCandle;
  const candleChangePct =
    displayCandle && displayCandle.open > 0
      ? ((displayCandle.close - displayCandle.open) / displayCandle.open) * 100
      : 0;

  const formattedDate = displayCandle
    ? new Date(displayCandle.time * 1000).toLocaleString('uk-UA', {
        year: 'numeric',
        month: 'short',
        day: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
        timeZone: 'UTC',
      }) + ' UTC'
    : '—';

  const content = (
    <div
      ref={fullscreenRootRef}
      style={isFullscreen
        ? {
            position: 'fixed',
            left: nativeFullscreenRef.current ? 0 : viewport.offsetLeft,
            top: nativeFullscreenRef.current ? 0 : viewport.offsetTop,
            width: nativeFullscreenRef.current ? '100vw' : `${viewport.width}px`,
            height: nativeFullscreenRef.current ? '100dvh' : `${viewport.height}px`,
            maxWidth: 'none',
            maxHeight: 'none',
          }
        : { width: '100%', height: `${viewport.height}px` }}
      className={`relative flex min-w-0 flex-col bg-[#090d16] border border-slate-800/80 rounded-2xl overflow-hidden shadow-xl ${
        isFullscreen ? 'z-[100] rounded-none' : 'w-full max-w-full'
      }`}
      role={isFullscreen ? 'dialog' : undefined}
      aria-modal={isFullscreen || undefined}
      aria-label={isFullscreen ? 'Повноекранний графік відтворення' : undefined}
    >
      {/* Chart Top Header Overlay */}
      <div className="flex flex-col sm:flex-row sm:flex-wrap sm:items-center justify-between gap-1.5 sm:gap-2 px-2 sm:px-3.5 py-1.5 sm:py-2.5 bg-slate-950/70 border-b border-slate-800/60 backdrop-blur-md z-10 text-xs">
        <div className="flex flex-wrap items-center min-w-0 max-w-full gap-1.5 sm:gap-2.5">
          <div className="flex items-center gap-1.5 font-mono">
            <span className="font-extrabold text-white text-sm sm:text-base">{symbol}</span>
            {chartProvider !== 'hookchart' && (
              <span className="px-1.5 py-0.5 rounded text-[10px] font-bold uppercase bg-amber-500/20 text-amber-300 border border-amber-500/30">
                {timeframe}
              </span>
            )}
            <span className="px-1.5 py-0.5 rounded text-[10px] font-bold uppercase bg-slate-800 text-slate-300">
              {exchange} {marketType}
            </span>
            {isReplaying && (
              <span className="flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-extrabold uppercase bg-amber-950/70 border border-amber-500/50 text-amber-300 animate-pulse">
                <span className="w-1.5 h-1.5 rounded-full bg-amber-400" />
                РЕЖИМ ВІДТВОРЕННЯ
              </span>
            )}
            {isFocusedBadge && (
              <span className="flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-bold bg-cyan-500/20 text-cyan-300 border border-cyan-500/40 animate-in fade-in duration-150">
                <span className="w-1.5 h-1.5 rounded-full bg-cyan-400 animate-ping" />
                🎯 Автофокус на свічках
              </span>
            )}
          </div>

          {/* Candle OHLC stats */}
          {displayCandle && (
            <div className="flex items-center w-full sm:w-auto min-w-0 max-w-full gap-2 overflow-x-auto whitespace-nowrap font-mono text-[10px] sm:text-[11px] text-slate-400" aria-label="Ціни відкриття, максимуму, мінімуму й закриття свічки">
              <span>
                O: <b className="text-slate-200">{formatCryptoPrice(displayCandle.open)}</b>
              </span>
              <span>
                H: <b className="text-emerald-400">{formatCryptoPrice(displayCandle.high)}</b>
              </span>
              <span>
                L: <b className="text-rose-400">{formatCryptoPrice(displayCandle.low)}</b>
              </span>
              <span>
                C: <b className={candleChangePct >= 0 ? 'text-emerald-400' : 'text-rose-400'}>
                  {formatCryptoPrice(displayCandle.close)}
                </b>
              </span>
              <span
                className={`font-semibold ${
                  candleChangePct >= 0 ? 'text-emerald-400' : 'text-rose-400'
                }`}
              >
                ({candleChangePct >= 0 ? '+' : ''}
                {candleChangePct.toFixed(2)}%)
              </span>
            </div>
          )}
        </div>

        {/* Action controls */}
        <div className="flex items-center w-full min-w-0 sm:w-auto gap-1.5 justify-between sm:justify-end">
          <div className="min-w-0 max-w-[55vw] sm:max-w-none text-[10px] sm:text-[11px] font-mono text-cyan-300/80 mr-1 flex items-center gap-1 bg-cyan-950/40 px-2 py-0.5 rounded border border-cyan-800/40 overflow-hidden whitespace-nowrap">

            <span className="truncate">📅 {formattedDate}</span>
          </div>

          <button
            onClick={() => {
              const img = captureScreenshot();
              if (img) {
                const link = document.createElement('a');
                link.download = `replay_${symbol}_${timeframe}_${displayCandle?.time || Date.now()}.png`;
                link.href = img;
                link.click();
                onTakeScreenshotNotification?.();
              }
            }}
            className="p-1.5 rounded-lg bg-slate-900 hover:bg-slate-800 text-slate-300 hover:text-white border border-slate-800 transition-colors"
            title="Завантажити скриншот графіка (PNG)"
          >
            <Camera className="w-3.5 h-3.5 text-cyan-400" />
          </button>

          <button
            onClick={() => chartProvider === 'hookchart' ? hookChartRef.current?.fitContent() : chartRef.current?.timeScale().fitContent()}
            className="p-1.5 rounded-lg bg-slate-900 hover:bg-slate-800 text-slate-300 hover:text-white border border-slate-800 transition-colors"
            title="Масштабувати графік (Fit Content)"
          >
            <RotateCcw className="w-3.5 h-3.5" />
          </button>

          <button
            type="button"
            onClick={() => { void toggleFullscreen(); }}
            className="p-1.5 rounded-lg bg-slate-900 hover:bg-slate-800 text-slate-300 hover:text-white border border-slate-800 transition-colors"
            title={isFullscreen ? 'Вийти з повного екрана' : 'Повний екран'}
            aria-label={isFullscreen ? 'Вийти з повного екрана' : 'Розгорнути графік на весь екран'}
          >
            {isFullscreen ? <Minimize2 className="w-3.5 h-3.5" /> : <Maximize2 className="w-3.5 h-3.5" />}
          </button>
        </div>
      </div>

      {/* Lightweight-chart fallback uses the same timeframe selection above its canvas. */}
      {chartProvider !== 'hookchart' && (
        <div className="flex items-center gap-1.5 overflow-x-auto px-3 py-2 border-b border-slate-800/60 bg-slate-950/70"
          role="group" aria-label="Таймфрейм відтворення">
          {(['1m', '5m', '15m', '1h', '4h', '1d'] as Timeframe[]).map(tf => (
            <button key={tf} type="button" disabled={isLoadingHistoricalData}
              aria-pressed={timeframe === tf} aria-label={`Таймфрейм ${tf}`}
              onClick={() => onTimeframeChange(tf)}
              className={`shrink-0 rounded-lg px-2.5 py-1 text-xs font-mono font-bold border transition-colors disabled:opacity-50 ${timeframe === tf
                ? 'bg-amber-500 text-slate-950 border-amber-400'
                : 'bg-slate-900 text-slate-300 border-slate-700 hover:border-amber-500/60'}`}>{tf}</button>
          ))}
        </div>
      )}

      {/* Main Chart Canvas Container */}
      {chartProvider === 'hookchart' ? <div className="flex-1 w-full min-h-0 relative select-none">
        <HookChart ref={hookChartRef} klines={visibleCandles} symbol={symbol} timeframe={timeframe}
          exchange={exchange} marketType={marketType} markers={hookMarkers} replay focusTrigger={focusTrigger}
          onTimeframeChange={onTimeframeChange} timeframeDisabled={isLoadingHistoricalData} />
      </div> : <div ref={chartContainerRef} data-chart-provider="tradingview" className="flex-1 w-full relative select-none" />}

      {/* Watermark in Replay */}
      <div className="absolute bottom-7 left-4 pointer-events-none opacity-20 font-mono text-xs text-slate-400">
        Навчальний режим • Майбутні свічки приховано
      </div>

    </div>
  );

  // Reserve the same block height in page flow when moving the fullscreen
  // overlay into document.body. Otherwise the page collapses and jumps down
  // as the user enters fullscreen in Safari / embedded mobile browsers.
  if (isFullscreen && !nativeFullscreenRef.current && typeof document !== 'undefined') {
    return <>
      <div aria-hidden="true" className="w-full max-w-full" style={{ height: `${viewport.height}px` }} />
      {createPortal(content, document.body)}
    </>;
  }
  return content;
});

ReplayChart.displayName = 'ReplayChart';

