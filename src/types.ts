import type { TpSlConstructorSettings, TpSlTouchState } from './utils/tpSlConstructor';
import type { WickTouchBar } from './utils/wickTouchEvidence';
export type ExchangeId = 'binance' | 'bybit';
export type MarketType = 'futures' | 'spot';
export type ChartProvider = 'tradingview' | 'hookchart';
export type Timeframe = '1m' | '5m' | '15m' | '1h' | '4h' | '1d';
export type ActivePageType = 'patterns' | 'screener' | 'terminal' | 'surveillance' | 'replay';

export interface TerminalChartBlock {
  id: string;
  symbol: string;
  baseAsset: string;
  quoteAsset: string;
  exchange: ExchangeId;
  marketType: MarketType;
  timeframe: Timeframe;
  formationId?: string;
  colSpan?: 1 | 2 | 3 | 4 | 'full';
  heightPx?: number;
}

export interface TerminalWorkspaceConfig {
  layoutPreset: '1x1' | '1x2' | '2x1' | '2x2' | '2x3' | '3x3' | '4x4' | '5x5' | '6x6' | 'custom';
  columns: 1 | 2 | 3 | 4 | 5 | 6;
  autoFitScreen: boolean;
  blocks: TerminalChartBlock[];
  showFormations: boolean;
  blockHeight: 'compact' | 'medium' | 'large';
  globalTimeframe?: Timeframe;
  coinPresetExchange?: 'all' | ExchangeId;
  coinPresetMarketType?: 'all' | MarketType;
  coinPresetLimit?: number;
}

export type PatternCategory = 'reversal' | 'continuation' | 'breakout' | 'compression' | 'candlestick';
export type PatternBias = 'bullish' | 'bearish' | 'neutral';
export type PatternStatus = 'forming' | 'breakout' | 'ready_to_break' | 'retest' | 'target_reached';

export interface Kline {
  buyVolume?: number;
  /** Binance taker-buy/total quote turnover; missing for Bybit OHLCV. */
  buyQuoteVolume?: number;
  quoteVolume?: number;
  tradeCount?: number;
  time: number; // Unix timestamp in seconds
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

export interface PatternLevel {
  label: string;
  price: number;
  type: 'support' | 'resistance' | 'neckline' | 'target' | 'stop_loss' | 'trigger';
}

export type ExtremeRole = 'UPPER_EXTREME' | 'LOWER_EXTREME' | 'MID_RANGE';
export type ExtremeApproach = 'APPROACHING' | 'TESTING' | 'REJECTING' | 'BREAKING' | 'MOVING_AWAY' | 'NEUTRAL';

export interface ExtremeContext {
  role: ExtremeRole;
  referencePrice: number;
  distancePct: number;
  rangePositionPct: number;
  approach: ExtremeApproach;
  approachStrength: number; // 0-100
  barsToExtreme: number;
  velocityPct: number;
  rejectionStrength: number; // 0-100
  sweepDetected: boolean;
  testsCount: number;
  aligned: boolean;
  reason: string;
}

export interface ConfluenceComponent {
  score: number;
  max: number;
  status: 'CONFIRMED' | 'PARTIAL' | 'MISSING' | 'CONFLICT';
  evidence: string;
  /** false means unavailable, not a measured failure (0 points). */
  available?: boolean;
}

export interface ConfluenceBreakdown {
  total: number;
  grade: 'A+' | 'A' | 'B' | 'C' | 'D';
  components: {
    formation: ConfluenceComponent;
    extremeLocation: ConfluenceComponent;
    trigger: ConfluenceComponent;
    retest: ConfluenceComponent;
    volume: ConfluenceComponent;
    volatility: ConfluenceComponent;
    level: ConfluenceComponent;
    riskReward: ConfluenceComponent;
    dataQuality: ConfluenceComponent;
    /** Only populated by the STANDARD formation scanner after indicator enrichment. */
    openInterest?: ConfluenceComponent;
    delta?: ConfluenceComponent;
    cvd20?: ConfluenceComponent;
    /** Standard-mode round price level, not a liquidity confirmation. */
    roundNumber?: ConfluenceComponent;
    /** Actual matching BID/ASK depth wall when the order book was checked. */
    density?: ConfluenceComponent;
    /** Standard-mode RSI14 momentum relative to the pattern direction. */
    rsi?: ConfluenceComponent;
    /** ATR14-based structural SL/TP suitability (separate from volatility band). */
    atr?: ConfluenceComponent;
    /** Small separate contribution from confirmed-breakout RVOL strength. */
    rvol?: ConfluenceComponent;
  };
  /** Unnormalized earned points and actually available maximum for transparent /100 scaling. */
  rawTotal?: number;
  availableMax?: number;
  flow?: import('./utils/regularFlowQuality').RegularFlowSummary;
  independentConfirmations: number;
  conflicts: string[];
  missing: string[];
  notes: string[];
}

export interface FormationValidation {
  passed: boolean;
  confirmed: boolean;
  closedCandleOnly: boolean;
  lookAheadSafe: boolean;
  enoughData: boolean;
  finiteData: boolean;
  swingQuality: number;
  equalExtremaTolerancePct: number;
  atrPct: number;
  breakoutConfirmed: boolean;
  breakoutPrice?: number;
  breakoutIndex?: number;
  entryMode: 'BREAKOUT' | 'RETEST' | 'WAIT_RETEST' | 'WAIT_BREAKOUT';
  entryPrice: number;
  stopPrice: number;
  targetPrice: number;
  riskReward: number;
  minRiskReward: number;
  volumeRatio: number;
  volatilityPct: number;
  nearbyLevelDistancePct: number;
  filters: { volume: boolean; volatility: boolean; nearbyLevel: boolean; structure: boolean };
  rejectionReasons: string[];
  confluence?: ConfluenceBreakdown;
}

export interface RoundNumberContext {
  detected: boolean;
  level?: number;
  distancePct: number;
  step: number;
  strength: number;
  densityConfirmed: boolean;
  densityUsd?: number;
  side?: 'BID' | 'ASK';
}

export interface DetectedFormation {
  id: string;
  patternKey: string;
  name: string;
  nameEn: string;
  category: PatternCategory;
  bias: PatternBias;
  confidence: number; // 0 - 100
  extremeContext?: ExtremeContext;
  validation?: FormationValidation;
  roundNumberContext?: RoundNumberContext;
  /** Conservative standard-mode TP/SL refinement; absent in early W/M. */
  regularSetupAdjustment?: import('./utils/regularFormationSetup').RegularSetupAdjustment;
  status: PatternStatus;
  statusLabel: string;
  description: string;
  levels: {
    entryPrice: number;
    targetPrice: number;
    stopLossPrice: number;
    supportPrice?: number;
    resistancePrice?: number;
    necklinePrice?: number;
  };
  riskRewardRatio: number;
  potentialProfitPct: number;
  potentialRiskPct: number;
  detectedAt: number;
  candleStartIndex?: number;
  candleEndIndex?: number;
  structureEndIndex?: number;
  /** Bounded closed-candle samples close to the relevant wick extreme; not user-specific. */
  wickTouchBars?: WickTouchBar[];
  /** Client-only user-scoped projection; never used by shared scanner validation. */
  tpSlBuilder?: { source: 'custom'; touches?: TpSlTouchState; levelStatus?: 'applied' | 'invalid' };
}

export interface RoundNumberDensity {
  level: number;
  side: 'BID' | 'ASK';
  notionalUsd: number;
  distancePct: number;
  quality: number;
}

/** Indicators based only on the completed candles of a standard screener scan. */
export interface RegularIndicatorValues {
  atrPct: number | null;
  rsi14: number | null;
  /** Binance only: signed taker-buy minus taker-sell quote turnover of last CLOSED candle. */
  deltaPct?: number;
  deltaUsd?: number;
  /** Binance only: 20 consecutive closed candles, fixed-window CVD (not all-time CVD). */
  cvd20Pct?: number;
  cvd20Usd?: number;
  /** Real futures OI change in native units across consecutive exchange snapshots. */
  oiChangePct?: number;
  oiUpdatedAt?: number;
  /** Why standard-mode OI was (not) available; not used by early W/M. */
  oiAvailability?: import('./utils/regularOIHistory').RegularOIReason;
  /** Which real market-data route produced the verified snapshot. */
  oiSource?: 'server' | 'browser';
}

export interface ScannedCoin {
  /** Populated by the normal screener; ignored by the early W/M mode. */
  regularIndicators?: RegularIndicatorValues;
  symbol: string;
  baseAsset: string;
  quoteAsset: string;
  exchange: ExchangeId;
  marketType: MarketType;
  currentPrice: number;
  priceChange24h: number;
  highPrice24h: number;
  lowPrice24h: number;
  volume24hUsd: number;
  volumeUsd?: number;
  formations: DetectedFormation[];
  /** Preliminary W/M structures displayed only when early detection is enabled. */
  earlyFormations?: import('./utils/earlyFormations').EarlyFormationCandidate[];
  roundNumberDensity?: RoundNumberDensity;
  timeframe: Timeframe;
  lastUpdated: number;
  /** Provenance of the closed candles used for this formation scan (milliseconds). */
  formationData?: { collectedAt: number; lastClosedAt: number; contiguous: true };
  exchangeUrl: string;
  high24h?: number;
  low24h?: number;
  hasFormations?: boolean;
  bestFormation?: DetectedFormation;
}

/** Progress of the explicit full-universe USDT W/M scan (separate from the 75-pair standard screener). */
export interface FullEarlyScanSnapshot {
  id: string;
  status: 'loading' | 'running' | 'stopping' | 'stopped' | 'completed' | 'partial' | 'failed';
  total: number;
  processed: number;
  checked: number;
  skipped: number;
  failed: number;
  startedAt: number;
  updatedAt: number;
  finishedAt?: number;
  message?: string;
  missingSources: string[];
  data: ScannedCoin[];
}

export interface ScreenerFilterState {
  exchange: 'all' | ExchangeId;
  marketType: 'all' | MarketType;
  timeframe: Timeframe;
  category: 'all' | PatternCategory;
  bias: 'all' | PatternBias;
  status: 'all' | PatternStatus;
  minVolumeUsd: number; // in USD
  densityConfirmedOnly: boolean; // require confirmed order-book liquidity at the formation level
  searchQuery: string;
  sortBy: 'confidence' | 'volume' | 'priceChange' | 'profitPotential';
  sortOrder: 'asc' | 'desc';
}

export interface FormationAIAnalysis {
  summary: string;
  patternConfirmation: string;
  targetAnalysis: string;
  invalidationCriteria: string;
  volumeRecommendation: string;
  tradeScenario: {
    recommendedEntry: string;
    tp1: string;
    tp2: string;
    stopLoss: string;
    rrRatio: string;
  };
  keyRisks: string[];
}

export type AlertCondition = 'gte' | 'lte';
export type AlertLevelType = 'entry' | 'target' | 'stop_loss' | 'custom';

export interface PriceAlert {
  id: string;
  userId?: string;
  symbol: string;
  exchange: ExchangeId;
  marketType: MarketType;
  targetPrice: number;
  condition: AlertCondition; // 'gte' (>=) or 'lte' (<=)
  note?: string;
  formationName?: string;
  levelType?: AlertLevelType;
  setupId?: string; // Grouping ID: setupId ├── ENTRY, ├── TARGET, └── STOP
  setupRole?: 'ENTRY' | 'TARGET' | 'STOP';
  createdAt: number;
  isActive: boolean;
  triggered: boolean;
  triggeredAt?: number;
  triggeredPrice?: number;
  /** Incremented only by an explicit user restart. A completed cycle cannot fire twice. */
  deliveryEpoch?: number;
  // Per-user telegram credentials
  telegramBotToken?: string;
  telegramChatId?: string;
  language?: 'uk' | 'en' | 'ru' | 'pl';
}

export interface AlertHistoryItem {
  id: string;
  userId: string;
  alertId?: string;
  symbol: string;
  exchange: ExchangeId;
  marketType: MarketType;
  condition: AlertCondition;
  targetPrice: number;
  triggeredPrice: number;
  formationName?: string;
  levelType?: AlertLevelType;
  note?: string;
  triggeredAt: number;
  telegramSent: boolean;
  telegramError?: string;
  telegramPending?: boolean;
  telegramDeliveryId?: string;
  /** Restart generation matching the fired alert's delivery cycle. */
  deliveryEpoch?: number;
  telegramMessageIds?: number[];
  telegramStatus?: 'sent' | 'failed' | 'not_configured';
  createdAt?: string;
}

export interface MetaScalpSettings {
  enabled: boolean;
  port: number;
  binding: string; // '001' - '500'
  autoSwitchOnClick: boolean;
  soundFeedback?: boolean;
}

export interface ChartTradeMarkerSettings {
  showEntry: boolean;
  showTarget: boolean;
  showStop: boolean;
  entryColor?: string;
  targetColor?: string;
  stopColor?: string;
  customLevels?: Record<string, { entry?: number; target?: number; stop?: number; note?: string }>;
}

export interface TerminalWorkspaceSettings {
  columns: number;
  blockHeight: 'compact' | 'medium' | 'large' | 'tall';
  blocks: any[];
  config?: Omit<TerminalWorkspaceConfig, 'blocks'>;
  customPresets?: TerminalSavedPreset[];
}

export interface TerminalSavedPreset {
  id: string;
  name: string;
  blocks: TerminalChartBlock[];
  columns: TerminalWorkspaceConfig['columns'];
  blockHeight: TerminalWorkspaceConfig['blockHeight'];
  createdAt: number;
}

export interface SearchUserSettings {
  minVolumeUsd?: number;
  presetFilter?: ScreenerPresetFilter;
  sortBy?: ScreenerSortBy;
  sortDirection?: 'asc' | 'desc';
}

export interface UserProfile {
  uid: string;
  email?: string | null;
  displayName?: string | null;
  photoURL?: string | null;
  telegramBotToken?: string;
  telegramChatId?: string;
  telegramBotUsername?: string;
  defaultExchange?: 'all' | ExchangeId;
  defaultMarketType?: 'all' | MarketType;
  defaultTimeframe?: Timeframe;
  defaultChartProvider?: ChartProvider;
  hookChartPreferences?: HookChartPreferences;
  timeZone?: string;
  soundAlertsEnabled?: boolean;
  /** Shared across all coin detail pages; true only hides the custom Telegram alert form. */
  telegramPriceAlertCollapsed?: boolean;
  /** Shared across all coin pages; only affects the Smart Analysis UI. */
  smartAnalysisCollapsed?: boolean;
  watchlist?: string[];
  watchlistFolders?: Record<string, string[]>;
  metaScalpSettings?: MetaScalpSettings;
  chartTradeMarkers?: ChartTradeMarkerSettings;
  terminalSettings?: TerminalWorkspaceSettings;
  searchSettings?: SearchUserSettings;
  inviteCode?: string;
  /** One-time install tip after account registration. Missing on older accounts = already handled. */
  installGuideTipShown?: boolean;
  createdAt?: string;
  updatedAt?: string;
  chartLabelSettings?: { entry: boolean; target: boolean; stop: boolean };
  tpSlConstructorSettings?: TpSlConstructorSettings;
}

export interface HookChartDrawing {
  id: string;
  type: string;
  pts: Array<{ t: number; p: number }>;
  text?: string;
}

export interface HookChartAlert {
  id: string;
  p: number;
  kind: 'level' | 'ray';
  created: number;
  fired?: boolean;
}

/** Normalized, account-wide live HookChart viewport preset (never an absolute coin price). */
export interface HookChartVisualProfile {
  visibleBars: number;
  verticalZoom: number;
  autoPriceScale: boolean;
  rightGapBars: number;
}

/** User-scoped display, indicator, alert, drawing, and language settings for HookChart. */
export interface HookChartPreferences {
  /** Per-context and per-device display presets. Replay intentionally ignores these. */
  visualProfiles?: Partial<Record<string, HookChartVisualProfile>>;
  drawingToolbarOpen?: boolean;
  terminalExtraToolsOpen?: boolean;
  indicators?: string[];
  overlays?: string[];
  drawings?: Record<string, HookChartDrawing[]>;
  alerts?: Record<string, HookChartAlert[]>;

  language?: 'uk' | 'pl' | 'ru' | 'en';
  siteLanguageAtSelection?: 'uk' | 'pl' | 'ru' | 'en';
  timezone?: string;
  tooltips?: boolean;
  notificationOpenNew?: boolean;

  maxChartCandles?: number;
  rightPadding?: number;
  rightPaddingEnabled?: boolean;
  rightPaddingVersion?: number;
  chartToolbar?: boolean;
  showTopToolbarIcons?: boolean;
  notificationDialog?: boolean;
  singleWindowSize?: number;
  pagingButtons?: boolean;
  sharedDrawings?: boolean;
  duplicateCrosshair?: boolean;
  crosshairLineWidth?: number;
  showMarketPrintSums?: boolean;
  showVolumes?: boolean;
  showMarketStatsBar?: boolean;
  showLiquidations?: boolean;
  showLiqRiskBlock?: boolean;
  /** Hide only Long/Short marks; never affect the session's collected volume. */
  showLiquidationLong?: boolean;
  showLiquidationShort?: boolean;
  /** Null/undefined = automatic, 0 = show all, positive = manual USD threshold. */
  liquidationLongMinUsd?: number | null;
  liquidationShortMinUsd?: number | null;

  gridHorizontal?: boolean;
  gridVertical?: boolean;
  candleLongColor?: string;
  candleShortColor?: string;
  densityLineColor?: string;
  densityLabelColor?: string;
  densityLineWidth?: number;
  densityLineStyle?: 'solid' | 'dash' | 'dot';
  densityLabelSize?: number;

  sortEnabled?: string[];
  sortDisabled?: string[];
  analyzedIntervals?: string[];
  scoring?: boolean;

  roundDistance?: boolean;
  roundness?: number;
  roundGrid?: boolean;

  levelIntervals?: string[];
  showNearestLevels?: boolean;
  levelCandleCount?: number;
  levelHistory?: number;
  levelCount?: number;
  levelDiff?: number;
  levelBreak?: number;
  levelLabelMode?: 'always' | 'hover' | 'off';
  levelLabelColor?: string;
  levelLabelSize?: number;
  levelLabelStyle?: 'text' | 'filled' | 'outline';
  levelLineStyle?: 'solid' | 'dash' | 'dot';
  showBrokenLevels?: boolean;
  allowWick?: boolean;

  trendIntervals?: string[];
  trendHistory?: number;

  densityAnalysis?: boolean;
  densityTop?: boolean;
  densityBaseVolume?: boolean;
  densityImbalance?: boolean;
  showDensityLines?: boolean;
  showDensityLabels?: boolean;
  showDensityAmounts?: boolean;
  densityTimeoutMin?: number;
  densityDiffPct?: number;
  densityAutoMultiplier?: number;
  /** AUTO chart display: all unusual walls, or only walls with observed reaction evidence. */
  densityAutoDisplay?: 'all' | 'potential';
  densityNearLevelsOnly?: boolean;
  densityMode?: 'auto' | 'manual';
  densityThreshold?: number;

  oiColumn?: boolean;
  oiDisplay?: 'value' | 'change';
  oiBaseChange?: boolean;
  oiPeriod?: '1h' | '12h' | '24h';
  fundingColumn?: boolean;
  change24?: boolean;
  volume24?: boolean;

  natrTf?: string;
  natrPeriod?: number;
  vrTf?: string;
  vrCandles?: number;
  pDeltaTf?: string;
  pAvgTf?: string;
  pAvgCandles?: number;
  rBtcTf?: string;
  rBtcCandles?: number;
  tradesWindow?: string;
  tradesTA?: boolean;
  tradesTR?: boolean;
  tradesCandles?: number;

  autoSR?: boolean;
  showSRLabels?: boolean;
  autoPrevDay?: boolean;
  autoDayOpen?: boolean;
  autoVWAP?: boolean;
  autoLocalHL?: boolean;
  autoRoundLevels?: boolean;
  autoChannel?: boolean;
  autoPOC?: boolean;
  autoStops?: boolean;

  strategyId?: string;
  hotkeys?: Record<string, string>;
}

export interface TelegramConfig {
  botToken?: string;
  chatId?: string;
}

export interface TelegramStatus {
  serverConfigured: boolean;
  isConfigured: boolean;
  needsConfirmation?: boolean;
  botUsername?: string;
  username?: string;
  linkPending?: boolean;
  linkExpiresAt?: number;
  linkError?: string;
  pollingError?: string;
}

export type ScreenerPresetFilter =
  | 'all'
  | 'active'
  | 'top_gainers'
  | 'top_losers'
  | 'near_highs'
  | 'near_lows';

export type ScreenerSortBy =
  | 'volume'
  | 'priceChange'
  | 'price'
  | 'volatility'
  | 'distanceToHigh'
  | 'distanceToLow';

export interface MarketCoin {
  symbol: string;
  baseAsset: string;
  quoteAsset: string;
  exchange: ExchangeId;
  marketType: MarketType;
  price: number;
  change24h: number;
  volumeUsd: number;
  high24h: number;
  low24h: number;
  distanceToHighPct: number;
  distanceToLowPct: number;
  volatility24hPct: number;
  volatility5mPct?: number;
  location?: import('./utils/marketLocation').MarketLocation;
  isNearHigh: boolean;
  isNearLow: boolean;
  isActiveCoin: boolean;
  exchangeUrl: string;
  hasFormations?: boolean;
  formationsCount?: number;
}

export interface ChartMarkerInfo {
  id: string;
  type: 'entry' | 'target' | 'stop_loss' | 'neckline' | 'resistance' | 'support' | 'custom' | 'pattern_point';
  label: string;
  price: number;
  color: string;
  lineStyle?: 'solid' | 'dashed' | 'dotted';
  lineWidth?: number;
  timeframe?: Timeframe;
  time?: number; // Candle timestamp in seconds
  position?: 'aboveBar' | 'belowBar' | 'inBar';
  shape?: 'circle' | 'square' | 'arrowUp' | 'arrowDown';
  notes?: string;
}

export interface ChartRestoreParams {
  timeframe: Timeframe;
  historyLimit: number;
  lastClosePrice: number;
  visibleRange?: { from: number; to: number };
  savedAtCandleTime?: number;
}

export interface ArchivedFormation {
  id: string;
  userId: string;
  symbol: string;
  baseAsset: string;
  quoteAsset: string;
  exchange: ExchangeId;
  marketType: MarketType;
  timeframe: Timeframe;
  formationName: string;
  bias: PatternBias;
  confidence?: number;
  status?: PatternStatus;
  entryPrice: number;
  targetPrice: number;
  stopLossPrice: number;
  necklinePrice?: number;
  resistancePrice?: number;
  supportPrice?: number;
  savedPrice: number;
  formation: DetectedFormation;
  markers: ChartMarkerInfo[];
  chartParams: ChartRestoreParams;
  notes?: string;
  createdAt: string;
  savedAtTimestamp: number;
}

export interface SmartAnalysisData {
  symbol: string;
  exchange: ExchangeId;
  marketType: MarketType;
  currentPrice: number;
  lastUpdated: number;

  // 1. Overall Score & Verdict
  score: number; // 1 to 10
  verdict: 'STRONG_BUY' | 'BUY' | 'NEUTRAL_WAIT' | 'SELL' | 'AVOID';
  verdictLabel: string;
  summary: string;
  positionSizingRecommendation: string;
  tradeScenario: {
    entryZoneMin: number;
    entryZoneMax: number;
    optimalEntry: number;
    stopLoss: number;
    stopLossPct: number;
    tp1: number;
    tp1Pct: number;
    tp2: number;
    tp2Pct: number;
    tp3: number;
    tp3Pct: number;
    riskRewardRatio: number;
  };

  // 2. Trend, RSI & Moving Averages
  trend: {
    rsi14: number;
    rsiStatus: 'oversold' | 'neutral' | 'overbought';
    rsiLabel: string;
    ema20: number;
    ema50: number;
    ema200: number;
    priceVsEma: string;
    crossSignal: 'golden_cross' | 'death_cross' | 'bullish_alignment' | 'bearish_alignment' | 'compression';
    crossSignalLabel: string;
    strengthPct: number;
  };

  // 3. BTC Multi-Timeframe Context
  btcContext: {
    btcPrice: number;
    change24h: number;
    timeframes: {
      '15m': { direction: 'up' | 'down' | 'sideways'; structure: 'HH_HL' | 'LH_LL' | 'range'; label: string };
      '5m': { direction: 'up' | 'down' | 'sideways'; structure: 'HH_HL' | 'LH_LL' | 'range'; label: string };
      '1m': { direction: 'up' | 'down' | 'sideways'; structure: 'HH_HL' | 'LH_LL' | 'range'; label: string };
    };
    overallStructure: 'HH_HL' | 'LH_LL' | 'range';
    overallStructureLabel: string;
    hasSharpImpulse: boolean;
    impulseType: 'pump' | 'dump' | 'none';
    impulseDescription: string;
    upcomingNews: Array<{
      title: string;
      timeUntil: string;
      impact: 'high' | 'medium' | 'low';
    }>;
  };

  // 4. Volumes, Spread & Volatility
  volumeMetrics: {
    volume24hUsd: number;
    volume1hUsd: number;
    volume1hSpikeRatio: number;
    hasVolumeSpike: boolean;
  };
  spread: {
    spreadUsd: number;
    spreadPct: number;
    quality: 'ultra_tight' | 'normal' | 'wide';
  };
  volatility: {
    dailyRangePct: number;
    atr: number;
    atrPct: number;
    positionInDayRangePct: number; // 0% = Low, 100% = High
    high24h: number;
    low24h: number;
  };

  // 5. Orderbook & Walls
  orderbook: {
    bidAskRatio: number;
    dominantSide: 'bids' | 'asks' | 'balanced';
    bidWallUsd: number;
    bidWallPrice: number;
    askWallUsd: number;
    askWallPrice: number;
    largeOrders: Array<{
      side: 'bid' | 'ask';
      price: number;
      amountUsd: number;
      distancePct: number;
      significance: 'whale' | 'large' | 'medium';
    }>;
  };

  // 6. Derivatives & Open Interest
  derivatives: {
    hasPerpFutures: boolean;
    fundingRate: number | null; // null = not published / unavailable
    predictedFundingRate: number | null;
    fundingBias: 'bullish' | 'bearish' | 'neutral';
    binanceOI: {
      currentUsd: number | null;
      change1hPct: number | null;
      history: number[]; // actual exchange history only
    };
    bybitOI: {
      currentUsd: number | null;
      change1hPct: number | null;
      history: number[]; // actual exchange history only
    };
    totalOIUsd: number | null; // partial total explicitly labeled by oiCoverage
    oiCoverage: 'complete' | 'partial' | 'none' | 'spot';
    oiTrend: 'increasing' | 'decreasing' | 'stable' | 'unknown';
  };

  // 7. POC, Liquidity Levels & S/R
  levels: {
    pocPrice: number;
    pocVolumePct: number;
    liquidityLevels: Array<{
      label: string;
      price: number;
      type: 'buy_side' | 'sell_side';
      distancePct: number;
    }>;
    strongSupport: number;
    strongResistance: number;
  };

  // 8. Institutional & Manipulation Analysis
  participants: {
    // 1. Аналіз Holders
    holders: {
      status: 'accumulation' | 'distribution' | 'neutral';
      statusLabel: string;
      top10ConcentrationPct: number;
      activeWalletsGrowthPct: number;
      retailVsWhaleRatio: string;
      phaseDescription: string;
    };
    // 2. Авто-виявлення Великого Учасника (Whale / Smart Money)
    largePlayer: {
      detected: boolean;
      confidencePct: number;
      actionType: 'accumulation' | 'absorption' | 'twap_buying' | 'distribution' | 'none';
      actionLabel: string;
      clusterVolumeUsd: number;
      details: string;
      trackedClusters: Array<{
        type: 'iceberg' | 'block_trade' | 'absorption' | 'twap';
        side: 'buy' | 'sell';
        price: number;
        volumeUsd: number;
        timestampDesc: string;
      }>;
    };
    // 3. Авто-виявлення Маркет-Мейкерів
    marketMaker: {
      detected: boolean;
      activityLevel: 'high' | 'moderate' | 'low';
      activityLabel: string;
      algorithmType: 'hft_grid' | 'spread_arbitrage' | 'synthetic_liquidity' | 'passive_quoting';
      spreadSupportScore: number; // 0 - 100
      orderbookReplenishmentSpeed: 'ultra_fast' | 'normal' | 'slow';
      antiSqueezeProtection: boolean;
      details: string;
    };
    // 4. Авто-виявлення Маніпулятивних Монет
    manipulativeCoin: {
      isManipulative: boolean;
      riskScore: number; // 0 to 100
      riskLevel: 'low' | 'medium' | 'high' | 'extreme';
      riskLabel: string;
      signals: Array<{
        name: string;
        detected: boolean;
        severity: 'low' | 'medium' | 'high';
        description: string;
      }>;
      warningSummary: string;
    };
    // Backwards compatibility legacy fields
    holdersStatus?: 'accumulation' | 'distribution' | 'neutral';
    holdersConcentrationPct?: number;
    largePlayerDetected?: boolean;
    largePlayerNote?: string;
    marketMakerDetected?: boolean;
    marketMakerNote?: string;
    isManipulativeCoin?: boolean;
    manipulativeRiskLevel?: 'low' | 'medium' | 'high' | 'extreme';
    manipulativeReasons?: string[];
  };
}

export interface MarketSentimentData {
  compositeScore: number; // 0 to 100
  sentimentState: 'extreme_fear' | 'fear' | 'neutral' | 'greed' | 'extreme_greed';
  sentimentLabel: string;
  summary: string;

  priceTrendDynamics: {
    advancingCount: number;
    decliningCount: number;
    advancingPct: number;
    trendBias: 'bullish' | 'bearish' | 'neutral';
    avgChange24h: number;
  };

  tradingVolume: {
    total24hUsd: number;
    volumeVelocity: 'high' | 'normal' | 'low';
    volumeChangePct: number;
  };

  marketVolatility: {
    index: number; // 0 - 100
    label: string;
    avgDailyRangePct: number;
  };

  marketBreadth: {
    aboveEma20Pct: number;
    nearHighsPct: number;
    nearLowsPct: number;
    breadthScore: number;
    verdict: string;
  };

  capitalFlow: {
    netInflow24hUsd: number;
    direction: 'inflow' | 'outflow' | 'neutral';
    label: string;
  };

  derivativesOverview: {
    aggregatedOIUsd: number;
    oiChange24hPct: number;
    avgFundingRate: number;
    fundingBias: 'long_heavy' | 'short_heavy' | 'balanced';
  };

  lastUpdated: number;
}

export type SurveillanceEventType = 'structure' | 'level' | 'momentum' | 'risk';

export type TriggerModeType = 'bar_close' | 'realtime' | 'bar_close_15m' | 'bar_close_1h';

export interface SurveillanceConfig {
  timeframe: Timeframe;
  triggerModes: TriggerModeType[];
  triggerMode?: TriggerModeType; // Backward compatibility
  levelsEnabled: boolean; // Senior 4H/1D & 15m/1H levels
  structureEnabled: boolean; // Market structure BOS/CHoCH
  momentumEnabled: boolean; // Moving Up/Down % in N bars
  momentumPct: number; // e.g. 2.5%
  momentumBars: number; // e.g. 3 bars
  momentumTf: '15m' | '1h' | '4h';
  channelEnabled: boolean; // Donchian/Bollinger breakout
  fibonacciEnabled: boolean; // 0.618 Golden Pocket zones
  cooldownMinutes: number; // Minutes between alerts for same event
  densityMode?: 'AUTO' | 'MANUAL' | 'HYBRID';
  manualDensityThresholdUsd?: number;
  formationThreshold?: number;
  confluenceThreshold?: number;
  thirdTouchAlerts?: boolean;
  densityAlerts?: boolean;
  oiAlerts?: boolean;
  newsAlerts?: boolean;
  setupsEnabled?: boolean;
  autoSetupsAlerts?: boolean;
  telegramEnabled?: boolean;
}

export interface SurveillanceEvent {
  id: string;
  type: SurveillanceEventType;
  title: string;
  description: string;
  price: number;
  timestamp: number;
  severity: 'info' | 'warning' | 'critical';
  details?: Record<string, any>;
}

export interface SurveillanceState {
  currentPrice: number;
  change24h: number;
  high1d: number;
  low1d: number;
  swingHigh4h: number;
  swingLow4h: number;
  localHigh1h: number;
  localLow1h: number;
  localHigh15m: number;
  localLow15m: number;
  rangePositionPct: number; // 0 - 100% position in 4H range
  resistance4h: number;
  support4h: number;
  nextZoneUp: number;
  nextZoneDown: number;
  fib618: number;
  fib786: number;
  structureTrend: 'bullish' | 'bearish' | 'consolidation';
  channelUpper: number;
  channelLower: number;
  momentumRecentPct?: number;
  momentumPct?: number;
  structureStatus?: string;
  lastEvent?: SurveillanceEvent;
  recentEvents?: SurveillanceEvent[];
  lastCalculated?: number;
  // 24/7 Engine Live Properties
  engineStatus?: 'LIVE' | 'SYNCING' | 'CONNECTING' | 'STALE' | 'ERROR';
  spreadPct?: number;
  bestBid?: number;
  bestAsk?: number;
  densitiesCount?: number;
  topDensityUsd?: number;
  topDensityPrice?: number;
  topDensitySide?: 'BID' | 'ASK';
  thirdTouchState?: string;
  thirdTouchDistancePct?: number;
  activeSetupType?: string;
  activeSetupStage?: string;
  activeSetupConfluence?: number;
  oiRegime?: string;
  oiChange15mPct?: number;
  oiAnomaly?: boolean;
  tradeFlowBuyUsd?: number;
  tradeFlowSellUsd?: number;
  tradeFlowImbalance?: number;
  btcTrend4h?: string;
  formationName?: string;
  formationScore?: number;
  lastProcessedCandleTimes?: {
    '15m'?: number;
    '1h'?: number;
    '4h'?: number;
  };
}

export interface SurveillanceCoin {
  id: string;
  userId: string;
  symbol: string;
  baseAsset: string;
  quoteAsset: string;
  exchange: ExchangeId;
  marketType: MarketType;
  isActive: boolean;
  createdAt: string;
  updatedAt: string;
  lastCheckedAt?: string;
  lastNotifiedAt?: string;
  config: SurveillanceConfig;
  state?: SurveillanceState;
}

// ==========================================
// Market Replay & Trading Simulator Types
// ==========================================

export type ReplayOrderType = 'market' | 'limit' | 'stop';
export type ReplayOrderSide = 'buy' | 'sell';
export type ReplayPositionSide = 'long' | 'short';

export interface ReplayPosition {
  id: string;
  symbol: string;
  side: ReplayPositionSide;
  entryPrice: number;
  currentPrice: number;
  sizeUsd: number;
  marginUsd: number;
  quantity: number;
  leverage: number;
  slPrice?: number;
  tpPrice?: number;
  entryTime: number;
  unrealizedPnlUsd: number;
  unrealizedPnlPct: number;
  liquidationPrice: number;
  tag?: string;
  entryScreenshot?: string;
}

export interface ReplayPendingOrder {
  id: string;
  symbol: string;
  side: ReplayOrderSide;
  orderType: 'limit' | 'stop';
  price: number;
  sizeUsd: number;
  leverage: number;
  slPrice?: number;
  tpPrice?: number;
  tag?: string;
  createdAtTime: number;
}

export interface ReplayTradeJournalItem {
  id: string;
  symbol: string;
  exchange: ExchangeId;
  marketType: MarketType;
  timeframe: Timeframe;
  side: ReplayPositionSide;
  entryPrice: number;
  exitPrice: number;
  entryTime: number;
  exitTime: number;
  sizeUsd: number;
  marginUsd: number;
  leverage: number;
  slPrice?: number;
  tpPrice?: number;
  pnlUsd: number;
  pnlPct: number;
  commissionUsd: number;
  tag: string;
  notes?: string;
  screenshotUrl?: string;
  exitReason: 'tp' | 'sl' | 'manual' | 'liquidation' | 'limit';
}

export interface ReplaySimulationSettings {
  balance: number;
  leverage: number;
  positionSizeUsd: number;
  commissionPct: number; // e.g. 0.05
  spreadPct: number;     // e.g. 0.02
  slippagePct: number;   // e.g. 0.02
  autoSlPct?: number;
  autoTpPct?: number;
}

