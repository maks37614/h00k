import React, { useState, useEffect, useLayoutEffect, useCallback, useMemo, useRef } from 'react';
import {
  ListChecks,
  ChevronDown,
  Send,
  Zap,
  Star,
  Search,
  PanelLeftClose,
  PanelLeftOpen,
  Trash2,
  RefreshCw,
  Plus,
  SlidersHorizontal,
  Maximize2,
  Minimize2,
  ArrowLeft,
  X,
  Grid,
  ScanLine,
} from 'lucide-react';
import {
  TerminalChartBlock,
  TerminalWorkspaceConfig,
  ScannedCoin,
  DetectedFormation,
  Timeframe,
  ExchangeId,
  MarketType,
  Kline,
  MarketCoin,
  TerminalSavedPreset,
} from '../types';
import { TerminalChartWidget } from './terminal/TerminalChartWidget';
import { ExchangeCandlestickChart } from './ExchangeCandlestickChart';
import { getTradingViewSymbol } from '../utils/marketSymbols';
import { AddChartModal } from './terminal/AddChartModal';
import { TerminalSettingsDrawer } from './terminal/TerminalSettingsDrawer';
import { formatVolume } from '../utils/formatters';
import { getStoredPreferences, useAppPreferences } from '../utils/userPreferences';
import { useAuth } from '../context/AuthContext';
import { useTerminalWorkspace } from '../utils/useTerminalWorkspace';
import { blocksForMarketPreset, normalizeTerminalMarketPair, formatTerminalQuotedPrice, MAX_TERMINAL_CHARTS } from '../utils/terminalPresets';
import { getTerminalPresetPage, pageAfterLimitChange, resolveTerminalPresetPageSize } from '../utils/terminalPresetPaging';
import { MARKET_PRESETS, coinMarketKey, type TerminalMarketPreset } from '../utils/marketPresets';
import { loadMarketCoins, type MarketCoinSnapshot } from '../utils/marketCoinLoader';
import { TerminalPresetPanel } from './terminal/TerminalPresetPanel';
import { TerminalClock } from './terminal/TerminalClock';
import { toggleFullscreenSafe } from '../utils/fullscreenUtils';
import { useChartProvider } from '../utils/useChartProvider';

interface TerminalPageProps {
  coins: ScannedCoin[];
  watchlist: string[];
  onToggleWatchlist: (symbol: string) => void;
  onSendMetaScalp?: (coin: ScannedCoin) => void;
  metaScalpBinding?: string;
  onOpenTelegramAlerts?: (prefill?: any) => void;
  onOpenFullscreenModal?: (coin: ScannedCoin, formation?: DetectedFormation) => void;
  onReturnToPatterns?: () => void;
}

export const TerminalPage: React.FC<TerminalPageProps> = ({
  coins: formationCoins,
  watchlist,
  onToggleWatchlist,
  onSendMetaScalp,
  metaScalpBinding = '001',
  onOpenTelegramAlerts,
  onOpenFullscreenModal,
  onReturnToPatterns,
}) => {
  const chartProvider = useChartProvider();
  const { preferences } = useAppPreferences();
  const { user, profile } = useAuth();
  const { blocks, config, customPresets, setBlocks: updateBlocks, setConfig, setCustomPresets, syncError, retrySync } = useTerminalWorkspace();
  const [activeMarketPreset, setActiveMarketPreset] = useState<TerminalMarketPreset | null>(null);
  const [presetMatches, setPresetMatches] = useState<MarketCoin[]>([]);
  const [presetPage, setPresetPage] = useState(0);
  const presetPageRef = useRef(0);
  const chartListRef = useRef<HTMLDivElement>(null);
  const [showCoinPresets, setShowCoinPresets] = useState(false);
  const [showTradingSessions, setShowTradingSessions] = useState(false);
  const clockButtonRef = useRef<HTMLButtonElement>(null);
  const presetsButtonRef = useRef<HTMLButtonElement>(null);
  const presetsMenuRef = useRef<HTMLDivElement>(null);
  const [presetsMenuPosition, setPresetsMenuPosition] = useState<React.CSSProperties>({});
  const [marketSnapshot, setMarketSnapshot] = useState<MarketCoinSnapshot>({ coins: [], timestamp: null, warning: null });
  const [marketLoading, setMarketLoading] = useState(true);
  const [marketError, setMarketError] = useState<string | null>(null);
  const marketCoins = marketSnapshot.coins;
  const terminalCoinCount = blocks.length;
  const [autoScaleCharts, setAutoScaleCharts] = useState<boolean>(() => {
    try { return localStorage.getItem('terminal_auto_scale_charts') === 'true'; }
    catch { return false; }
  });
  useEffect(() => {
    try { localStorage.setItem('terminal_auto_scale_charts', String(autoScaleCharts)); }
    catch { /* Private browsing may disable storage. */ }
  }, [autoScaleCharts]);

  useEffect(() => {
    const controller = new AbortController();
    let busy = false;
    let lastRequestAt = 0;
    const load = async () => {
      // A background Terminal tab must not keep polling every exchange.
      // Also avoid a double refresh when visibilitychange and the timer coincide.
      if (busy || controller.signal.aborted || document.visibilityState === 'hidden') return;
      const now = Date.now();
      if (now - lastRequestAt < 25_000) return;
      lastRequestAt = now;
      busy = true;
      setMarketLoading(true);
      try {
        const next = await loadMarketCoins({ exchange: 'all', marketType: 'all' }, controller.signal);
        if (controller.signal.aborted) return;
        setMarketSnapshot(next);
        setMarketError(null);
      } catch (cause) {
        if (!controller.signal.aborted) setMarketError(cause instanceof Error ? cause.message : 'Не вдалося оновити монети.');
      } finally {
        busy = false;
        if (!controller.signal.aborted) setMarketLoading(false);
      }
    };
    const onVisibilityChange = () => {
      if (document.visibilityState === 'visible') void load();
    };
    document.addEventListener('visibilitychange', onVisibilityChange);
    void load();
    const timer = setInterval(() => { void load(); }, 30_000);
    return () => {
      controller.abort();
      clearInterval(timer);
      document.removeEventListener('visibilitychange', onVisibilityChange);
    };
  }, []);

  const coinPresetSelection = useMemo(() => ({
    exchange: config.coinPresetExchange ?? preferences.defaultExchange,
    marketType: config.coinPresetMarketType ?? preferences.defaultMarketType,
  }), [config.coinPresetExchange, config.coinPresetMarketType, preferences.defaultExchange, preferences.defaultMarketType]);
  const coinPresetLimit = resolveTerminalPresetPageSize(config.coinPresetLimit);
  const visiblePresetPage = useMemo(() => getTerminalPresetPage(presetMatches, presetPage, coinPresetLimit),
    [presetMatches, presetPage, coinPresetLimit]);
  const coins = useMemo(() => {
    if (!marketCoins.length) return formationCoins;
    const formations = new Map(formationCoins.map(coin => [coinMarketKey(coin), coin]));
    return marketCoins.map(coin => ({
      ...formations.get(coinMarketKey(coin)), ...coin,
      currentPrice: coin.price, priceChange24h: coin.change24h, volume24hUsd: coin.volumeUsd,
      highPrice24h: coin.high24h, lowPrice24h: coin.low24h,
      formations: formations.get(coinMarketKey(coin))?.formations || [],
      // Preserve market-data provenance. Rebuilding a coin card is not a fresh
      // exchange update and must not turn an old quote into a current one.
      timeframe: preferences.defaultTimeframe, lastUpdated: marketSnapshot.timestamp ?? 0,
    } as ScannedCoin));
  }, [marketCoins, marketSnapshot.timestamp, formationCoins, preferences.defaultTimeframe]);
  // Any manual edit stops the automatic selection from restoring a removed chart.
  const setBlocks: typeof updateBlocks = useCallback(update => {
    setActiveMarketPreset(null);
    setPresetMatches([]);
    presetPageRef.current = 0;
    setPresetPage(0);
    updateBlocks(update);
  }, [updateBlocks]);

  // Active coin for single-chart full view (matching FullscreenChartModal)
  const [activeCoin, setActiveCoin] = useState<ScannedCoin>(() => {
    const firstBlock = blocks[0];
    const found = coins.find((c) => firstBlock && coinMarketKey(c) === coinMarketKey(firstBlock));
    if (found) return found;
    return {
      symbol: firstBlock?.symbol || 'BTCUSDT',
      baseAsset: firstBlock?.baseAsset || 'BTC',
      quoteAsset: firstBlock?.quoteAsset || 'USDT',
      exchange: firstBlock?.exchange || ('binance' as ExchangeId),
      marketType: firstBlock?.marketType || ('futures' as MarketType),
      currentPrice: 0,
      priceChange24h: 0,
      formations: [],
    } as unknown as ScannedCoin;
  });

  // Saved presets also work for a coin whose live quote is temporarily unavailable.
  useEffect(() => {
    const firstBlock = blocks[0];
    if (!firstBlock) return;
    const match = coins.find(coin => coinMarketKey(coin) === coinMarketKey(firstBlock));
    setActiveCoin(current => match || (coinMarketKey(current) === coinMarketKey(firstBlock) ? current : {
      ...firstBlock, currentPrice: 0, priceChange24h: 0, highPrice24h: 0, lowPrice24h: 0,
      volume24hUsd: 0, formations: [], lastUpdated: 0, exchangeUrl: '',
    }));
  }, [coins, blocks]);

  const [timeframe, setTimeframe] = useState<Timeframe>(() => getStoredPreferences().defaultTimeframe);
  // A saved one-chart block may use a different timeframe from the global selector.
  const activeTimeframe = blocks.length === 1 ? blocks[0].timeframe : timeframe;

  useEffect(() => {
    setTimeframe(preferences.defaultTimeframe);
  }, [preferences.defaultTimeframe]);
  const [isFavoritesDrawerOpen, setIsFavoritesDrawerOpen] = useState<boolean>(false);
  const [searchQuery, setSearchQuery] = useState<string>('');
  const [showDrawingToolbar, setShowDrawingToolbar] = useState<boolean>(() => {
    try {
      const saved = localStorage.getItem('fullscreen_show_drawing_toolbar');
      return saved !== null ? saved === 'true' : true;
    } catch {
      return true;
    }
  });
  const [iframeLoading, setIframeLoading] = useState<boolean>(true);

  // Modal / Drawer state for multi-chart mode
  const [isAddModalOpen, setIsAddModalOpen] = useState(false);
  const [isSettingsOpen, setIsSettingsOpen] = useState(false);
  const [maximizedBlockId, setMaximizedBlockId] = useState<string | null>(null);
  const [isBrowserFullscreen, setIsBrowserFullscreen] = useState(false);
  const [draggedBlockIndex, setDraggedBlockIndex] = useState<number | null>(null);

  const [localWatchlist, setLocalWatchlist] = useState<string[]>(() => [...new Set(watchlist)]);
  useEffect(() => { setLocalWatchlist([...new Set(watchlist)]); }, [watchlist]);

  // Browser fullscreen change listener
  useEffect(() => {
    const handleFullscreenChange = () => {
      setIsBrowserFullscreen(!!document.fullscreenElement);
    };
    document.addEventListener('fullscreenchange', handleFullscreenChange);
    return () => document.removeEventListener('fullscreenchange', handleFullscreenChange);
  }, []);

  useEffect(() => {
    if (!showCoinPresets) return;
    presetsMenuRef.current?.querySelector<HTMLButtonElement>('button:not([disabled])')?.focus();
  }, [showCoinPresets]);

  useLayoutEffect(() => {
    if (!showCoinPresets) return;
    const positionMenu = () => {
      const anchor = presetsButtonRef.current?.getBoundingClientRect();
      if (!anchor) return;
      const margin = 12;
      const width = Math.min(360, Math.max(0, window.innerWidth - margin * 2));
      const headerBottom = presetsButtonRef.current?.closest('header')?.getBoundingClientRect().bottom ?? anchor.bottom;
      const top = headerBottom + 6;
      const left = (window.innerWidth - width) / 2;
      setPresetsMenuPosition({ top, left, width, maxHeight: Math.max(0, window.innerHeight - top - margin) });
    };
    const dismissOutside = (event: Event) => {
      const target = event.target as Node | null;
      if (target && !presetsMenuRef.current?.contains(target) && !presetsButtonRef.current?.contains(target)) {
        setShowCoinPresets(false);
        if (event.type === 'pointerdown') presetsButtonRef.current?.focus();
      }
    };
    const repositionOnScroll = (event: Event) => {
      if (event.target === window || !presetsMenuRef.current?.contains(event.target as Node)) positionMenu();
    };
    const dismissOnWindowBlur = () => setShowCoinPresets(false);
    positionMenu();
    document.addEventListener('pointerdown', dismissOutside);
    document.addEventListener('focusin', dismissOutside);
    window.addEventListener('resize', positionMenu);
    window.addEventListener('scroll', repositionOnScroll, true);
    window.addEventListener('blur', dismissOnWindowBlur);
    return () => {
      document.removeEventListener('pointerdown', dismissOutside);
      document.removeEventListener('focusin', dismissOutside);
      window.removeEventListener('resize', positionMenu);
      window.removeEventListener('scroll', repositionOnScroll, true);
      window.removeEventListener('blur', dismissOnWindowBlur);
    };
  }, [showCoinPresets, terminalCoinCount]);

  const closePresetsMenu = useCallback(() => {
    setShowCoinPresets(false);
    presetsButtonRef.current?.focus();
  }, []);

  const handlePresetsMenuKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      closePresetsMenu();
    }
  };

  // Handle Escape key to close the presets menu, drawer or return to screener
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        if (showTradingSessions) {
          e.preventDefault();
          setShowTradingSessions(false);
          clockButtonRef.current?.focus();
        } else if (showCoinPresets) {
          e.preventDefault();
          closePresetsMenu();
        } else if (isFavoritesDrawerOpen) {
          setIsFavoritesDrawerOpen(false);
        } else if (onReturnToPatterns) {
          e.preventDefault();
          onReturnToPatterns();
        }
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [showTradingSessions, showCoinPresets, closePresetsMenu, isFavoritesDrawerOpen, onReturnToPatterns]);

  const toggleBrowserFullscreen = () => {
    toggleFullscreenSafe();
  };

  const handleToggleDrawingToolbar = useCallback(() => {
    setShowDrawingToolbar((prev) => {
      const next = !prev;
      try {
        localStorage.setItem('fullscreen_show_drawing_toolbar', String(next));
      } catch {}
      return next;
    });
  }, []);

  // Watchlist favorites items
  const favoriteCoins = useMemo(() => {
    const uniqueSymbols: string[] = Array.from(new Set<string>(localWatchlist));
    const coinsMap = new Map<string, ScannedCoin>();
    coins.forEach((c) => {
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
  }, [coins, localWatchlist]);

  const filteredFavorites = useMemo(() => {
    if (!searchQuery.trim()) return favoriteCoins;
    const q = searchQuery.toLowerCase().trim();
    return favoriteCoins.filter(
      (c) =>
        c.symbol.toLowerCase().includes(q) ||
        c.baseAsset.toLowerCase().includes(q)
    );
  }, [favoriteCoins, searchQuery]);

  const handleRemoveFromWatchlist = (sym: string, e: React.MouseEvent) => {
    e.stopPropagation();
    setLocalWatchlist((prev) => {
      const next = prev.filter((s) => s !== sym);
      return next;
    });
    onToggleWatchlist?.(sym);
  };

  const handleSelectFavoriteCoin = (favCoin: ScannedCoin) => {
    setActiveCoin(favCoin);
    setIframeLoading(true);
    // Update the first block to match the selected coin
    if (blocks.length === 1) {
      setBlocks([
        {
          id: `block-${favCoin.symbol}-${Date.now()}`,
          symbol: favCoin.symbol,
          baseAsset: favCoin.baseAsset,
          quoteAsset: favCoin.quoteAsset,
          exchange: favCoin.exchange,
          marketType: favCoin.marketType,
          timeframe: activeTimeframe,
          colSpan: 1,
        },
      ]);
    }
  };

  // Build TradingView Embed URL
  const tradingViewUrl = useMemo(() => {
    if (chartProvider === 'hookchart') return null;
    const tvSymbol = getTradingViewSymbol(activeCoin.symbol, activeCoin.exchange, activeCoin.marketType);
    if (!tvSymbol) return null;

    let interval = '15';
    switch (activeTimeframe) {
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
  }, [chartProvider, activeCoin.symbol, activeCoin.exchange, activeCoin.marketType, activeTimeframe]);

  // Block management
  const handleAddChart = (coin: MarketCoin | ScannedCoin | Pick<TerminalChartBlock, 'symbol' | 'baseAsset' | 'quoteAsset' | 'exchange' | 'marketType'>, tf: Timeframe, formationId?: string) => {
    const { symbol, quoteAsset: quote } = normalizeTerminalMarketPair(coin.symbol, coin.quoteAsset);
    const base = coin.baseAsset || symbol.slice(0, -quote.length);
    const exchange = coin.exchange || 'binance';
    const marketType = coin.marketType || 'futures';

    const newBlock: TerminalChartBlock = {
      // Rapidly adding the same symbol must never reuse a React chart key.
      id: `block-${symbol}-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`,
      symbol,
      baseAsset: base,
      quoteAsset: quote,
      exchange,
      marketType,
      timeframe: tf || config.globalTimeframe || '15m',
      formationId,
      colSpan: 1,
    };
    // At most 50 simultaneous live charts. Guard inside the updater as well:
    // two rapid click events must not exceed the limit before React rerenders.
    if (blocks.length >= MAX_TERMINAL_CHARTS) return;
    setBlocks((prev) => prev.length >= MAX_TERMINAL_CHARTS ? prev : [...prev, newBlock]);
  };

  const handleUpdateBlock = (blockId: string, updated: Partial<TerminalChartBlock>) => {
    setBlocks((prev) =>
      prev.map((b) => (b.id === blockId ? { ...b, ...updated } : b))
    );
  };

  const handleRemoveBlock = (blockId: string) => {
    setBlocks((prev) => prev.filter((b) => b.id !== blockId));
    if (maximizedBlockId === blockId) {
      setMaximizedBlockId(null);
    }
  };

  const handleDragStart = (index: number) => {
    setDraggedBlockIndex(index);
  };

  const handleDragOver = (e: React.DragEvent) => {
    e.preventDefault();
  };

  const handleDrop = (targetIndex: number) => {
    const sourceIndex = draggedBlockIndex;
    if (sourceIndex !== null && sourceIndex !== targetIndex) {
      setBlocks((prev) => {
        if (sourceIndex < 0 || sourceIndex >= prev.length || targetIndex < 0 || targetIndex >= prev.length) return prev;
        const updated = [...prev];
        const [movedItem] = updated.splice(sourceIndex, 1);
        updated.splice(targetIndex, 0, movedItem);
        return updated;
      });
    }
    setDraggedBlockIndex(null);
  };

  const handleApplyGlobalTimeframe = (tf: Timeframe) => {
    setTimeframe(tf);
    setConfig((prev) => ({ ...prev, globalTimeframe: tf }));
    // A global timeframe change must not discard the active auto-updating
    // market preset or reset its current pagination.
    updateBlocks((prev) => prev.map((b) => b.timeframe === tf ? b : { ...b, timeframe: tf }));
  };

  const handleTimeframeSelect = (tf: Timeframe) => {
    setTimeframe(tf);
    handleApplyGlobalTimeframe(tf);
    setIframeLoading(true);
  };

  const handleApplyPreset = (presetKey: 'focus_btc' | 'top_3' | 'top_4_patterns' | 'grid_4') => {
    if (presetKey === 'focus_btc') {
      const btc = coins.find((c) => c.symbol === 'BTCUSDT') || {
        symbol: 'BTCUSDT',
        baseAsset: 'BTC',
        quoteAsset: 'USDT',
        exchange: 'binance' as ExchangeId,
        marketType: 'futures' as MarketType,
      };
      setBlocks([
        {
          id: `block-btc-${Date.now()}`,
          symbol: btc.symbol,
          baseAsset: btc.baseAsset,
          quoteAsset: btc.quoteAsset,
          exchange: btc.exchange,
          marketType: btc.marketType,
          timeframe: '15m',
          colSpan: 'full',
        },
      ]);
      setConfig((prev) => ({ ...prev, layoutPreset: '1x1', columns: 1, autoFitScreen: true }));
    } else if (presetKey === 'top_3') {
      const symbols = ['BTCUSDT', 'ETHUSDT', 'SOLUSDT'];
      const newBlocks = symbols.map((sym, i) => {
        const c = coins.find((coin) => coin.symbol === sym) || {
          symbol: sym,
          baseAsset: sym.replace('USDT', ''),
          quoteAsset: 'USDT',
          exchange: 'binance' as ExchangeId,
          marketType: 'futures' as MarketType,
        };
        return {
          id: `block-${sym}-${Date.now()}-${i}`,
          symbol: c.symbol,
          baseAsset: c.baseAsset,
          quoteAsset: c.quoteAsset,
          exchange: c.exchange,
          marketType: c.marketType,
          timeframe: '15m' as Timeframe,
          colSpan: (i === 0 ? 2 : 1) as any,
        };
      });
      setBlocks(newBlocks);
      setConfig((prev) => ({ ...prev, layoutPreset: 'custom', columns: 2, autoFitScreen: true }));
    } else if (presetKey === 'grid_4') {
      const symbols = ['BTCUSDT', 'ETHUSDT', 'SOLUSDT', 'SUIUSDT'];
      const newBlocks = symbols.map((sym, i) => {
        const c = coins.find((coin) => coin.symbol === sym) || {
          symbol: sym,
          baseAsset: sym.replace('USDT', ''),
          quoteAsset: 'USDT',
          exchange: 'binance' as ExchangeId,
          marketType: 'futures' as MarketType,
        };
        return {
          id: `block-${sym}-${Date.now()}-${i}`,
          symbol: c.symbol,
          baseAsset: c.baseAsset,
          quoteAsset: c.quoteAsset,
          exchange: c.exchange,
          marketType: c.marketType,
          timeframe: '15m' as Timeframe,
          colSpan: 1 as const,
        };
      });
      setBlocks(newBlocks);
      setConfig((prev) => ({ ...prev, layoutPreset: '2x2', columns: 2, autoFitScreen: true }));
    } else if (presetKey === 'top_4_patterns') {
      const coinsWithPatterns = coins
        .filter((c) => c.formations && c.formations.length > 0)
        .slice(0, 4);

      if (coinsWithPatterns.length > 0) {
        const newBlocks = coinsWithPatterns.map((c, i) => ({
          id: `block-pattern-${c.symbol}-${Date.now()}-${i}`,
          symbol: c.symbol,
          baseAsset: c.baseAsset,
          quoteAsset: c.quoteAsset,
          exchange: c.exchange,
          marketType: c.marketType,
          timeframe: c.timeframe || '15m',
          formationId: c.formations[0]?.id,
          colSpan: 1 as const,
        }));
        setBlocks(newBlocks);
        setConfig((prev) => ({ ...prev, layoutPreset: '2x2', columns: 2, autoFitScreen: true }));
      }
    }
  };

  const applyPresetPage = useCallback((selected: MarketCoin[], requestedPage: number, pageSize = coinPresetLimit) => {
    if (!selected.length) return;
    const { page, coins: pageCoins } = getTerminalPresetPage(selected, requestedPage, pageSize);
    presetPageRef.current = page;
    setPresetPage(page);
    updateBlocks(current => blocksForMarketPreset(current, pageCoins, timeframe));
    setConfig(current => {
      const columns = pageCoins.length === 1 ? 1 : pageCoins.length <= 4 ? 2 : pageCoins.length <= 9 ? 3 : 4;
      return current.columns === columns && current.layoutPreset === 'custom' ? current
        : { ...current, columns, layoutPreset: 'custom' };
    });
    setMaximizedBlockId(null);
  }, [updateBlocks, setConfig, timeframe, coinPresetLimit]);

  const handleWorkspaceConfigUpdate = useCallback((updated: Partial<TerminalWorkspaceConfig>) => {
    if (updated.coinPresetLimit === undefined) {
      setConfig(current => ({ ...current, ...updated }));
      return;
    }

    const nextLimit = resolveTerminalPresetPageSize(updated.coinPresetLimit);
    const nextPage = pageAfterLimitChange(presetPageRef.current, coinPresetLimit, nextLimit);
    presetPageRef.current = nextPage;
    if (activeMarketPreset && presetMatches.length) {
      // Apply immediately: the visible chart count must not depend on the next market refresh.
      applyPresetPage(presetMatches, nextPage, nextLimit);
      chartListRef.current?.scrollTo({ top: 0 });
    }
    setConfig(current => ({ ...current, ...updated, coinPresetLimit: nextLimit }));
  }, [activeMarketPreset, presetMatches, coinPresetLimit, applyPresetPage, setConfig]);

  const goToPresetPage = useCallback((nextPage: number) => {
    applyPresetPage(presetMatches, nextPage);
    chartListRef.current?.scrollTo({ top: 0, behavior: 'smooth' });
  }, [applyPresetPage, presetMatches]);

  const handleApplyMarketCoins = useCallback((selected: MarketCoin[]) => {
    if (!selected.length) return;
    setPresetMatches(selected);
    applyPresetPage(selected, presetPageRef.current);
  }, [applyPresetPage]);

  const handleActiveMarketPresetChange = useCallback((preset: TerminalMarketPreset | null) => {
    presetPageRef.current = 0;
    setPresetPage(0);
    setActiveMarketPreset(preset);
    if (!preset) setPresetMatches([]);
  }, []);

  // Changing the number of charts per page also updates the displayed slice.
  useEffect(() => {
    if (activeMarketPreset && presetMatches.length) applyPresetPage(presetMatches, presetPageRef.current);
  }, [activeMarketPreset, presetMatches, applyPresetPage]);

  const handleSaveCoinPreset = (name: string, selected: TerminalChartBlock[]) => {
    const preset: TerminalSavedPreset = {
      id: `preset-${crypto.randomUUID()}`, name, blocks: selected.map(block => ({ ...block })),
      columns: config.columns, blockHeight: config.blockHeight, createdAt: Date.now(),
    };
    setCustomPresets(current => [...current, preset]);
  };

  const handleLoadCoinPreset = (preset: TerminalSavedPreset) => {
    setBlocks(preset.blocks.map(block => ({ ...block })));
    setConfig(current => ({ ...current, columns: preset.columns, blockHeight: preset.blockHeight, layoutPreset: 'custom' }));
    setTimeframe(preset.blocks[0]?.timeframe || timeframe);
    setMaximizedBlockId(null);
    setIframeLoading(true);
  };

  const handleResetWorkspace = () => {
    setBlocks([]);
    setMaximizedBlockId(null);
  };

  // Index quotes once per refresh instead of searching thousands of coins for every chart.
  const coinsByMarket = useMemo(() => {
    const index = new Map<string, ScannedCoin>();
    for (const coin of coins) {
      const key = coinMarketKey(coin);
      if (!index.has(key)) index.set(key, coin);
    }
    return index;
  }, [coins]);
  const getCoinForBlock = useCallback(
    (block: TerminalChartBlock): ScannedCoin | undefined => coinsByMarket.get(coinMarketKey(block)),
    [coinsByMarket]
  );

  const gridColsClass = useMemo(() => {
    if (blocks.length === 1) return 'grid-cols-1';
    switch (config.columns) {
      case 1: return 'grid-cols-1';
      case 2: return 'grid-cols-1 md:grid-cols-2';
      case 3: return 'grid-cols-1 md:grid-cols-2 xl:grid-cols-3';
      case 4: return 'grid-cols-1 md:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4';
      case 5: return 'grid-cols-1 md:grid-cols-2 lg:grid-cols-3 xl:grid-cols-5';
      case 6: return 'grid-cols-1 md:grid-cols-2 lg:grid-cols-3 xl:grid-cols-6';
      default: return 'grid-cols-1 md:grid-cols-2';
    }
  }, [config.columns, blocks.length]);

  const computedHeightStyle = useMemo(() => {
    if (blocks.length === 1) {
      return 'calc(100vh - 105px)';
    }

    if (!config.autoFitScreen) {
      switch (config.blockHeight) {
        case 'compact': return '280px';
        case 'medium': return '380px';
        case 'large': return '500px';
        default: return '380px';
      }
    }

    const cols = config.columns || 2;
    const total = blocks.length;
    const rows = Math.ceil(total / cols);

    if (rows <= 1) {
      return 'calc(100vh - 110px)';
    } else if (rows === 2) {
      return 'calc((100vh - 120px) / 2)';
    } else {
      return 'calc((100vh - 130px) / 3)';
    }
  }, [blocks.length, config.autoFitScreen, config.blockHeight, config.columns]);

  // A loaded quote snapshot is not proof of an active WebSocket stream.
  // Having a snapshot does not make it fresh forever (for example after
  // resuming a background tab or an interrupted market connection).
  const quotesAvailable = marketSnapshot.timestamp !== null
    && Number.isFinite(marketSnapshot.timestamp)
    && Date.now() - marketSnapshot.timestamp >= 0
    && Date.now() - marketSnapshot.timestamp <= 90_000
    && !marketError && !marketSnapshot.warning;

  // Header shortcuts have a unique target only when the Terminal displays one
  // chart and its loaded instrument matches that chart. Grid cards carry their
  // own explicit coin actions, so never silently target the first grid coin.
  const hasHeaderTarget = blocks.length === 1 && coinMarketKey(activeCoin) === coinMarketKey(blocks[0]);
  const formation = activeCoin.formations?.[0] || null;
  const isBullish = formation?.bias === 'bullish';
  const isBearish = formation?.bias === 'bearish';
  const presetPagination = activeMarketPreset && presetMatches.length > 0 ? (
    <nav aria-label="Сторінки монет активного пресету" className="mt-3 flex flex-wrap items-center justify-between gap-2 rounded-lg border border-slate-800 bg-slate-900/80 px-3 py-2 text-[11px] text-slate-300">
      <span>
        <strong className="text-cyan-300">{MARKET_PRESETS.find(preset => preset.id === activeMarketPreset)?.label}</strong>
        {' · '}знайдено {presetMatches.length} монет
        {' · '}графіки {visiblePresetPage.start + 1}–{visiblePresetPage.end}
      </span>
      <div className="flex items-center gap-1.5">
        <button type="button" disabled={visiblePresetPage.page === 0} onClick={() => goToPresetPage(visiblePresetPage.page - 1)}
          className="rounded-md border border-slate-700 px-2 py-1 hover:text-white disabled:opacity-40">← Назад</button>
        <span className="font-mono tabular-nums">{visiblePresetPage.page + 1}/{visiblePresetPage.pageCount}</span>
        <button type="button" disabled={visiblePresetPage.page + 1 >= visiblePresetPage.pageCount} onClick={() => goToPresetPage(visiblePresetPage.page + 1)}
          className="rounded-md border border-slate-700 px-2 py-1 hover:text-white disabled:opacity-40">Далі →</button>
      </div>
    </nav>
  ) : null;

  // One autoscale action, shown in its original position on phones/tablets
  // and next to the timeframe row on desktop.
  const renderAutoScaleButton = () => (
          <button
            type="button"
            onClick={() => setAutoScaleCharts(enabled => !enabled)}
            disabled={chartProvider !== 'hookchart'}
            aria-label="Автоматичний масштаб свічок усіх графіків"
            aria-pressed={autoScaleCharts && chartProvider === 'hookchart'}
            title={chartProvider !== 'hookchart'
              ? 'Автомасштабування доступне для HookChart'
              : autoScaleCharts
                ? 'Вимкнути автоматичне масштабування свічок усіх графіків'
                : 'Автоматично підлаштовувати всі графіки так, щоб свічки не перекривали об’єми'}
            className={`flex h-7 w-8 shrink-0 items-center justify-center justify-self-start rounded-lg border transition-colors disabled:cursor-not-allowed disabled:opacity-40 ${autoScaleCharts && chartProvider === 'hookchart'
              ? 'border-cyan-500/50 bg-cyan-500/15 text-cyan-300'
              : 'border-slate-700/80 bg-slate-900 text-slate-400 hover:text-cyan-300'}`}
          >
            <ScanLine className="h-4 w-4" />
          </button>
  );

  return (
    <div
      className="fixed inset-0 z-40 w-screen h-[100dvh] max-h-[100dvh] min-h-[100dvh] bg-[#090d16] flex flex-col overflow-hidden select-none animate-in fade-in duration-200"
      role="region"
      aria-label="Термінал трейдера"
    >
      {/* Block count, centered clock and actions above the chart controls */}
      <header className="z-20 flex shrink-0 flex-col gap-1.5 border-b border-slate-800 bg-slate-950/95 px-2 py-1.5 sm:px-3">
        <div className="grid w-full min-w-0 grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)] items-center sm:gap-2">
          <div className="justify-self-start lg:hidden">
            {renderAutoScaleButton()}
          </div>

          {/* Explicit center-column placement keeps the clock at the page midpoint
              even when the autoscale button is hidden on desktop. */}
          <div className="col-start-2 row-start-1 justify-self-center">
            <TerminalClock timeZone={profile?.timeZone} open={showTradingSessions} buttonRef={clockButtonRef}
              onOpenChange={setShowTradingSessions} onOpen={() => setShowCoinPresets(false)} />
          </div>

          {/* Telegram, MetaScalp, Settings, Fullscreen */}
          <div className="col-start-3 row-start-1 flex shrink-0 items-center justify-self-end gap-0 min-[375px]:gap-0.5 sm:gap-2">
            {/* Telegram Alert shortcut */}
            {onOpenTelegramAlerts && hasHeaderTarget && (
              <button
                onClick={() =>
                  onOpenTelegramAlerts({
                    symbol: activeCoin.symbol,
                    exchange: activeCoin.exchange,
                    marketType: activeCoin.marketType,
                    currentPrice: activeCoin.currentPrice,
                    targetPrice: formation?.levels?.targetPrice,
                    formationName: formation?.name,
                  })
                }
                className="flex h-7 w-6 shrink-0 items-center justify-center p-0 sm:h-auto sm:w-auto sm:p-2 rounded-xl bg-sky-500/10 hover:bg-sky-500/20 text-sky-300 border-0 lg:h-8 lg:w-8 lg:rounded-lg lg:border lg:border-sky-500/35 transition-all active:scale-95 cursor-pointer"
                title="Створити сповіщення в Telegram"
                aria-label="Створити сповіщення в Telegram"
              >
                <Send className="w-3.5 h-3.5 sm:w-4 sm:h-4 text-sky-400" />
              </button>
            )}

            {/* MetaScalp shortcut */}
            {onSendMetaScalp && hasHeaderTarget && (
              <button
                onClick={() => onSendMetaScalp(activeCoin)}
                className="flex h-7 w-6 shrink-0 items-center justify-center p-0 sm:h-auto sm:w-auto sm:p-2 rounded-xl bg-amber-500/10 hover:bg-amber-500/20 text-amber-300 border-0 lg:h-8 lg:w-8 lg:rounded-lg lg:border lg:border-amber-500/35 transition-all active:scale-95 cursor-pointer"
                title={`Надіслати в обраний термінал (Група ${metaScalpBinding})`}
                aria-label={`Надіслати в обраний термінал (Група ${metaScalpBinding})`}
              >
                <Zap className="w-3.5 h-3.5 sm:w-4 sm:h-4 text-amber-400 fill-amber-400/20" />
              </button>
            )}

            {/* Settings Drawer */}
            <button
              onClick={() => setIsSettingsOpen(true)}
              className="flex h-7 w-6 shrink-0 items-center justify-center p-0 sm:h-auto sm:w-auto sm:p-2 rounded-xl bg-slate-900 hover:bg-slate-800 border-0 lg:h-8 lg:w-8 lg:rounded-lg lg:border lg:border-slate-700 text-slate-300 hover:text-white transition-colors cursor-pointer"
              title="Налаштування робочого простору"
            >
              <SlidersHorizontal className="w-3.5 h-3.5 sm:w-4 sm:h-4 text-cyan-400" />
            </button>

            {/* Browser Fullscreen Button */}
            <button
              onClick={toggleBrowserFullscreen}
              className="flex h-7 w-6 shrink-0 items-center justify-center p-0 sm:h-auto sm:w-auto sm:p-2 rounded-xl bg-slate-900 hover:bg-slate-800 border-0 lg:h-8 lg:w-8 lg:rounded-lg lg:border lg:border-slate-700 text-slate-300 hover:text-white transition-colors cursor-pointer"
              title={isBrowserFullscreen ? 'Вийти з повноекранного режиму' : 'На весь екран браузера'}
            >
              {isBrowserFullscreen ? <Minimize2 className="w-3.5 h-3.5 sm:w-4 sm:h-4" /> : <Maximize2 className="w-3.5 h-3.5 sm:w-4 sm:h-4" />}
            </button>

            {/* Close / Return X button */}
            {onReturnToPatterns && (
              <button
                onClick={onReturnToPatterns}
                className="flex h-7 w-6 shrink-0 items-center justify-center p-0 sm:h-auto sm:w-auto sm:p-2 rounded-xl text-slate-400 hover:text-white hover:bg-slate-800 border-0 lg:h-8 lg:w-8 lg:rounded-lg lg:border lg:border-slate-700 transition-colors cursor-pointer"
                title="Закрити термінал (повернутися до скрінера)"
                aria-label="Закрити термінал"
              >
                <X className="w-3.5 h-3.5 sm:w-5 sm:h-5" />
              </button>
            )}
          </div>
        </div>

        <div className="grid w-full min-w-0 grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)] items-center gap-1 sm:gap-2">
          {/* Keep both rows' center columns aligned: the clock sits directly above timeframes. */}
          <div className="col-start-1 row-start-1 flex w-full min-w-0 items-center justify-self-stretch gap-1 sm:gap-2">
            <span
              title="Кількість відкритих блоків монет"
              aria-label={`Відкритих блоків монет: ${terminalCoinCount}`}
              className="whitespace-nowrap font-mono text-[11px] text-cyan-400 sm:text-xs"
            >
              Монет: {terminalCoinCount}
            </span>
          <div className="hidden shrink-0 items-center lg:ml-auto lg:flex">
            {renderAutoScaleButton()}
          </div>
            <div className="hidden shrink-0 items-center bg-slate-900 p-0.5 lg:flex rounded-xl border border-slate-800 text-xs font-mono">
            <button
              onClick={() => {
                // Column selectors are layout-only: never remove existing charts.
                setConfig((prev) => ({ ...prev, layoutPreset: 'custom', columns: 1, autoFitScreen: true }));
              }}
              className={`px-2 py-1 rounded-lg transition-colors ${
                config.columns === 1
                  ? 'bg-emerald-600 text-white font-bold'
                  : 'text-slate-400 hover:text-white'
              }`}
              title="1 колонка (зберегти всі графіки)"
            >
              1x
            </button>
            <button
              onClick={() => {
                setConfig((prev) => ({ ...prev, layoutPreset: 'custom', columns: 2, autoFitScreen: true }));
              }}
              className={`px-2 py-1 rounded-lg transition-colors ${
                config.columns === 2
                  ? 'bg-emerald-600 text-white font-bold'
                  : 'text-slate-400 hover:text-white'
              }`}
              title="2 Колонки"
            >
              2x
            </button>
            <button
              onClick={() => {
                setConfig((prev) => ({ ...prev, layoutPreset: 'custom', columns: 3, autoFitScreen: true }));
              }}
              className={`px-2 py-1 rounded-lg transition-colors ${
                config.columns === 3
                  ? 'bg-emerald-600 text-white font-bold'
                  : 'text-slate-400 hover:text-white'
              }`}
              title="3 Колонки"
            >
              3x
            </button>
            <button
              onClick={() => {
                setConfig((prev) => ({ ...prev, layoutPreset: 'custom', columns: 4, autoFitScreen: true }));
              }}
              className={`px-2 py-1 rounded-lg transition-colors ${
                config.columns === 4
                  ? 'bg-emerald-600 text-white font-bold'
                  : 'text-slate-400 hover:text-white'
              }`}
              title="4 Колонки"
            >
              4x
            </button>
            </div>
          </div>

          {/* Timeframe Selector */}
          <div className="col-start-2 row-start-1 flex shrink-0 items-center justify-self-center bg-slate-900 p-0.5 rounded-xl border border-slate-800 text-xs font-mono">
            {(['1m', '5m', '15m', '1h', '4h', '1d'] as Timeframe[]).map((tf) => (
              <button
                key={tf}
                onClick={() => {
                  setTimeframe(tf);
                  handleApplyGlobalTimeframe(tf);
                  setIframeLoading(true);
                }}
                className={`px-2 py-1 rounded-lg transition-colors cursor-pointer ${
                  activeTimeframe === tf
                    ? 'bg-cyan-600 text-white font-bold shadow-sm'
                    : 'text-slate-400 hover:text-slate-200'
                }`}
              >
                {tf}
              </button>
            ))}
          </div>

          <div className="col-start-3 row-start-1 flex items-center justify-self-start gap-1 sm:gap-2">
            <button
              ref={presetsButtonRef}
              type="button"
              onClick={() => { if (showCoinPresets) closePresetsMenu(); else { setShowTradingSessions(false); setShowCoinPresets(true); } }}
              className={`flex items-center gap-1 p-1.5 sm:p-2 rounded-xl border-0 transition-colors cursor-pointer ${showCoinPresets
                ? 'bg-cyan-500/10 hover:bg-cyan-500/20 text-cyan-300'
                : 'bg-slate-900 hover:bg-slate-800 text-slate-300 hover:text-white'}`}
              title={showCoinPresets ? 'Закрити пресети монет' : 'Відкрити пресети монет'}
              aria-label="Пресети монет"
              aria-expanded={showCoinPresets}
              aria-controls="terminal-coin-presets"
            >
              <ListChecks className="w-4 h-4" />
              <ChevronDown className={`h-3 w-3 transition-transform ${showCoinPresets ? 'rotate-180' : ''}`} />
            </button>

            <button
              type="button"
              onClick={() => {
                setIsAddModalOpen(true);
              }}
              className="flex shrink-0 items-center justify-center border-0 bg-transparent p-1.5 text-slate-300 shadow-none transition-colors hover:text-cyan-300 active:scale-95 cursor-pointer sm:p-2"
              title="Додати новий графік монети (понад 2,400+ монет на біржі від $50k до $10B)"
              aria-label="Додати графік"
            >
              <Plus className="w-4 h-4" />
            </button>
          </div>
        </div>
      </header>

      <div
        ref={presetsMenuRef}
        id="terminal-coin-presets"
        role="region"
        aria-label="Пресети монет"
        hidden={!showCoinPresets}
        onKeyDown={handlePresetsMenuKeyDown}
        style={presetsMenuPosition}
        className={`${showCoinPresets ? 'flex' : 'hidden'} fixed z-50 flex-col overflow-hidden rounded-xl border border-slate-700 bg-slate-950 shadow-2xl`}
      >
        <div className="min-h-0 overflow-y-auto">
          <TerminalPresetPanel
            blocks={blocks} watchlist={localWatchlist} presets={customPresets}
            selection={coinPresetSelection} timeframe={timeframe} activePreset={activeMarketPreset} autoUpdate
            snapshot={marketSnapshot} loading={marketLoading} error={marketError}
            onActivePresetChange={handleActiveMarketPresetChange}
            onPresetChosen={() => setShowCoinPresets(false)}
            onApplyCoins={handleApplyMarketCoins} onSavePreset={handleSaveCoinPreset}
            onLoadPreset={handleLoadCoinPreset} onDeletePreset={id => setCustomPresets(current => current.filter(preset => preset.id !== id))}
            syncError={syncError} onRetrySync={retrySync} signedIn={Boolean(user)}
          />
        </div>
      </div>

      {/* Sub-header: 24h Coin Market Stats Bar */}
      {blocks.length === 1 && (
        <div className="h-8 sm:h-9 bg-slate-950/80 border-b border-slate-800/80 px-3 sm:px-4 flex items-center justify-between gap-2 text-[11px] font-mono shrink-0 overflow-x-auto no-scrollbar">
          <div className="flex items-center gap-3 sm:gap-6 shrink-0">
            <span className="flex items-center gap-1 text-slate-300">
              Об'єм 24г: <strong className="text-white">{formatVolume(activeCoin.volume24hUsd || 0)}</strong>
            </span>
            {activeCoin.highPrice24h ? (
              <span className="flex items-center gap-1 text-emerald-400">
                Max 24г: <strong>{formatTerminalQuotedPrice(activeCoin.highPrice24h, activeCoin.quoteAsset)}</strong>
              </span>
            ) : null}
            {activeCoin.lowPrice24h ? (
              <span className="flex items-center gap-1 text-rose-400">
                Min 24г: <strong>{formatTerminalQuotedPrice(activeCoin.lowPrice24h, activeCoin.quoteAsset)}</strong>
              </span>
            ) : null}
          </div>

          <div className="flex items-center gap-3 text-slate-400 text-[11px] shrink-0">
            <span className="flex items-center gap-1.5 text-slate-300">
              <span className={`h-2 w-2 rounded-full ${quotesAvailable ? 'bg-emerald-500' : 'bg-amber-500'}`}></span>
              Котирування: <strong className={quotesAvailable ? 'text-cyan-400 font-bold' : 'text-amber-300 font-bold'}>
                {quotesAvailable ? 'оновлено' : marketLoading && !marketSnapshot.timestamp ? 'завантаження' : 'неповні дані'}
              </strong>
            </span>
            <span className="text-slate-500">|</span>
            <span>
              Таймфрейм: <strong className="text-cyan-400 font-bold">{activeTimeframe}</strong>
            </span>
          </div>
        </div>
      )}

      {/* Main Content Area (100% remaining space) */}
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
              title="Сховати"
            >
              <PanelLeftClose className="w-4 h-4" />
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

          {/* Quick Add Chart button in Drawer */}
          <div className="p-2 border-b border-slate-800/60 bg-slate-900/40">
            <button
              onClick={() => {
                setIsAddModalOpen(true);
              }}
              className="w-full flex items-center justify-center gap-1.5 py-1.5 px-3 rounded-lg bg-cyan-600/20 hover:bg-cyan-600 text-cyan-300 hover:text-white border border-cyan-500/30 text-xs font-bold transition-all cursor-pointer shadow-sm"
              title="Додати графік будь-якої монети з біржі"
            >
              <Plus className="w-3.5 h-3.5" />
              <span>+ Додати графік у термінал</span>
            </button>
          </div>

          {/* Coins List in Drawer */}
          <div className="flex-1 overflow-y-auto p-2 space-y-1.5 touch-scroll">
            {filteredFavorites.length === 0 ? (
              <div className="text-center py-10 px-4 text-slate-500 text-xs space-y-2">
                <Star className="w-6 h-6 text-slate-700 mx-auto" />
                <p className="font-semibold text-slate-400">Немає обраних монет</p>
                <p className="text-[11px] text-slate-600">
                  Натисніть на зірочку біля монет у скрінері, щоб вони з'явились тут.
                </p>
              </div>
            ) : (
              filteredFavorites.map((favCoin, idx) => {
                const isSelected = favCoin.symbol === activeCoin.symbol;
                const isFavPositive = (favCoin.priceChange24h || 0) >= 0;
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
                          {favCoin.exchange || 'binance'}
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
                            {formatTerminalQuotedPrice(favCoin.currentPrice, favCoin.quoteAsset)}
                          </div>
                        )}
                        <div
                          className={`text-[10px] font-mono font-semibold ${
                            isFavPositive ? 'text-emerald-400' : 'text-rose-400'
                          }`}
                        >
                          {isFavPositive ? '+' : ''}
                          {(favCoin.priceChange24h || 0).toFixed(2)}%
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

        {/* Workspace Display: If 1 block or maximized block, show full single chart. If multiple blocks, show multi-chart grid */}
        {blocks.length === 1 ? (
          /* Single Screen 100% View TradingView Pro */
          <div className="flex h-full w-full flex-col overflow-hidden">
            <div className="relative min-h-0 flex-1 overflow-hidden">
            {tradingViewUrl ? (
              <>
                {iframeLoading && (
                  <div className="absolute inset-0 flex flex-col items-center justify-center bg-slate-950 text-slate-400 gap-3 z-10 pointer-events-none">
                    <RefreshCw className="w-8 h-8 animate-spin text-cyan-400" />
                    <span className="text-sm font-medium">Завантаження графіку {activeCoin.symbol}...</span>
                  </div>
                )}
                <div
                  className={`absolute top-0 h-full transition-[width,left] duration-200 ease-in-out ${
                    showDrawingToolbar ? 'left-0 w-full' : '-left-[54px] w-[calc(100%+54px)]'
                  }`}
                >
                  <iframe
                    key={tradingViewUrl}
                    src={tradingViewUrl}
                    className="h-full w-full border-0"
                    title={`TradingView Chart ${activeCoin.symbol}`}
                    onLoad={() => setIframeLoading(false)}
                    allow="fullscreen"
                    loading="lazy"
                  />
                </div>
                <div
                  className={`pointer-events-none absolute inset-y-0 left-0 z-10 w-[54px] bg-transparent transition-transform duration-200 ${
                    showDrawingToolbar ? '-translate-x-full' : 'translate-x-0'
                  }`}
                  aria-hidden={showDrawingToolbar}
                />
                <div className="absolute bottom-2 left-2 z-20 flex items-center gap-2">
                  <button
                    type="button"
                    onClick={handleToggleDrawingToolbar}
                    className="flex h-8 w-8 items-center justify-center rounded-lg bg-slate-900/85 hover:bg-slate-800 border border-slate-700/80 text-slate-300 hover:text-cyan-300 shadow-md backdrop-blur-sm transition-all cursor-pointer group"
                    title={showDrawingToolbar ? 'Сховати панель TradingView' : 'Показати панель TradingView'}
                    aria-label={showDrawingToolbar ? 'Сховати панель TradingView' : 'Показати панель TradingView'}
                  >
                    {showDrawingToolbar ? <PanelLeftClose className="h-4 w-4" /> : <PanelLeftOpen className="h-4 w-4" />}
                  </button>
                </div>
              </>
            ) : (
              <ExchangeCandlestickChart
                visualContext="terminalLarge"
                symbol={activeCoin.symbol}
                terminalAutoScale={autoScaleCharts && chartProvider === 'hookchart'}
                terminalInitialView={config.initialChartView}
                exchange={activeCoin.exchange}
                marketType={activeCoin.marketType}
                timeframe={activeTimeframe}
              />
            )}
            </div>
            {presetPagination && <div className="shrink-0 px-2 pb-2">{presetPagination}</div>}
          </div>
        ) : (
          /* Multi-chart Grid Layout */
          <div ref={chartListRef} className="w-full h-full p-2 sm:p-3 overflow-y-auto no-scrollbar">
            {blocks.length === 0 ? (
              <div className="flex flex-col items-center justify-center p-8 sm:p-16 text-center border border-dashed border-slate-800 rounded-2xl bg-slate-950/40 my-8 max-w-lg mx-auto">
                <div className="w-14 h-14 rounded-2xl bg-cyan-500/10 border border-cyan-500/30 flex items-center justify-center text-cyan-400 mb-4 shadow-inner">
                  <Plus className="w-7 h-7" />
                </div>
                <h3 className="text-lg font-bold text-white mb-1">Робоча область порожня</h3>
                <p className="text-xs text-slate-400 mb-5 leading-relaxed">
                  Додайте графік будь-якої монети з біржі Binance або Bybit. Доступно понад 2,400+ монет від $50k до $10B.
                </p>
                <button
                  onClick={() => {
                    setIsAddModalOpen(true);
                  }}
                  className="flex items-center gap-2 px-4 py-2.5 rounded-xl bg-gradient-to-r from-cyan-600 to-cyan-500 hover:from-cyan-500 hover:to-cyan-400 text-white text-xs font-bold shadow-lg shadow-cyan-950/50 transition-all active:scale-95 cursor-pointer border border-cyan-400/30"
                >
                  <Plus className="w-4 h-4" />
                  + Додати перший графік
                </button>
              </div>
            ) : (
              <>
              <div className={`grid ${gridColsClass} gap-2 sm:gap-3 transition-all duration-200`}>
                {blocks.map((block, index) => {
                  const coinData = getCoinForBlock(block);
                  const isMaximized = maximizedBlockId === block.id;

                  return (
                    <TerminalChartWidget
                      key={block.id}
                      block={block}
                      terminalAutoScale={autoScaleCharts && chartProvider === 'hookchart'}
                      terminalInitialView={config.initialChartView}
                      coin={coinData}
                      allCoins={coins}
                      isSingleBlock={blocks.length === 1}
                      isMaximized={isMaximized}
                      isSuspended={maximizedBlockId !== null && !isMaximized}
                      onToggleMaximize={() =>
                        setMaximizedBlockId((prev) => (prev === block.id ? null : block.id))
                      }
                      onRemove={() => handleRemoveBlock(block.id)}
                      onUpdateBlock={(updated) => handleUpdateBlock(block.id, updated)}
                      onOpenFullscreenModal={onOpenFullscreenModal}
                      onSendMetaScalp={onSendMetaScalp}
                      metaScalpBinding={metaScalpBinding}
                      onOpenTelegramAlerts={onOpenTelegramAlerts}
                      onDragStart={() => handleDragStart(index)}
                      onDragOver={handleDragOver}
                      onDrop={(e) => {
                        e.preventDefault();
                        handleDrop(index);
                      }}
                      heightStyle={computedHeightStyle}
                    />
                  );
                })}

                {/* "+ Додати графік" Tile Card at the end of grid */}
                <div
                  onClick={() => {
                    setIsAddModalOpen(true);
                  }}
                  className="flex flex-col items-center justify-center gap-2.5 p-6 rounded-xl border border-dashed border-slate-800 hover:border-cyan-500/50 bg-slate-950/25 hover:bg-cyan-950/15 transition-all cursor-pointer group text-slate-500 hover:text-cyan-400 min-h-[320px] select-none"
                  title="Додати ще один графік монети у термінал"
                >
                  <div className="w-12 h-12 rounded-2xl bg-slate-900 group-hover:bg-cyan-500/20 border border-slate-800 group-hover:border-cyan-500/40 flex items-center justify-center text-slate-400 group-hover:text-cyan-300 transition-colors shadow-sm">
                    <Plus className="w-6 h-6" />
                  </div>
                  <div className="text-center">
                    <span className="text-sm font-bold text-slate-300 group-hover:text-white transition-colors block">
                      + Додати графік
                    </span>
                    <span className="text-[11px] text-slate-500 group-hover:text-slate-300 transition-colors block mt-0.5">
                      2,400+ монет на біржі ($50k - $10B)
                    </span>
                  </div>
                </div>
              </div>
              {presetPagination}
              </>
            )}
          </div>
        )}
      </main>

      {/* Add Chart Modal */}
      <AddChartModal
        isOpen={isAddModalOpen}
        onClose={() => setIsAddModalOpen(false)}
        coins={coins}
        terminalMarketCoins={marketCoins}
        atChartLimit={blocks.length >= MAX_TERMINAL_CHARTS}
        watchlist={localWatchlist}
        onAddChart={handleAddChart}
      />

      {/* Workspace Settings Drawer */}
      <TerminalSettingsDrawer
        isOpen={isSettingsOpen}
        onClose={() => setIsSettingsOpen(false)}
        config={config}
        coinSelection={coinPresetSelection}
        coinLimit={coinPresetLimit}
        onUpdateConfig={handleWorkspaceConfigUpdate}
        onApplyGlobalTimeframe={handleApplyGlobalTimeframe}
        onApplyPreset={handleApplyPreset}
        onResetWorkspace={handleResetWorkspace}
        totalBlocks={blocks.length}
      />
    </div>
  );
};
