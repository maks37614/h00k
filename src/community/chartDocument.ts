import type {
  ChartMarkerInfo,
  ChartRestoreParams,
  ExchangeId,
  HookChartDrawing,
  Kline,
  MarketType,
  Timeframe,
} from "../types";

export const COMMUNITY_TIMEFRAMES: Timeframe[] = [
  "1m",
  "5m",
  "15m",
  "1h",
  "4h",
  "1d",
];
export const TF_SECONDS: Record<Timeframe, number> = {
  "1m": 60,
  "5m": 300,
  "15m": 900,
  "1h": 3600,
  "4h": 14400,
  "1d": 86400,
};
export interface ChartDocument {
  version: 1;
  symbol: string;
  exchange: ExchangeId;
  marketType: MarketType;
  timeframe: Timeframe;
  capturedAt: number;
  /** Seconds, like canonical Kline.time. No live updates beyond this horizon. */
  cutoff: number;
  series: Partial<Record<Timeframe, Kline[]>>;
  markers: ChartMarkerInfo[];
  drawings: HookChartDrawing[];
  viewport?: ChartRestoreParams["visibleRange"];
}

export function cloneChartDocument(document: ChartDocument): ChartDocument {
  return JSON.parse(JSON.stringify(document));
}

/** A plain-data snapshot; never shares writable arrays with the terminal or a parent. */
export function captureChartDocument(
  input: Omit<ChartDocument, "version" | "capturedAt" | "cutoff" | "series"> & {
    candles: Kline[];
    capturedAt?: number;
  },
): ChartDocument {
  const capturedAt = input.capturedAt ?? Date.now();
  const cutoff = Math.floor(capturedAt / 1000);
  return normalizeChartDocument({
    ...input,
    version: 1,
    capturedAt,
    cutoff,
    series: { [input.timeframe]: input.candles },
  });
}

function finite(value: unknown, minimum = -Number.MAX_VALUE): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < minimum)
    throw new Error("Некоректні дані графіка");
  return value;
}
function text(value: unknown, max: number): string {
  return typeof value === "string" ? value.slice(0, max) : "";
}

/** Shared by the client and server. Whitelists fields and bounds untrusted snapshots. */
export function normalizeChartDocument(raw: any): ChartDocument {
  if (
    !raw ||
    raw.version !== 1 ||
    !["binance", "bybit"].includes(raw.exchange) ||
    !["spot", "futures"].includes(raw.marketType) ||
    !COMMUNITY_TIMEFRAMES.includes(raw.timeframe) ||
    typeof raw.symbol !== "string" ||
    !/^[\p{L}\p{M}\p{N}]{2,30}$/u.test(raw.symbol)
  )
    throw new Error("Непідтримуваний графік");
  const cutoff = finite(raw.cutoff, 1);
  const capturedAt = finite(raw.capturedAt, 1);
  if (
    cutoff > Math.floor(capturedAt / 1000) ||
    capturedAt > Date.now() + 60_000
  )
    throw new Error("Некоректний час знімка");
  const series: ChartDocument["series"] = {};
  let total = 0;
  for (const tf of COMMUNITY_TIMEFRAMES) {
    const source = raw.series?.[tf];
    if (source === undefined) continue;
    if (!Array.isArray(source) || source.length > 2000)
      throw new Error("Забагато свічок");
    const rows = new Map<number, Kline>();
    for (const candle of source) {
      const time = finite(candle.time, 1);
      if (!Number.isInteger(time) || time > cutoff) continue;
      const open = finite(candle.open, 0),
        high = finite(candle.high, 0),
        low = finite(candle.low, 0),
        close = finite(candle.close, 0);
      if (
        open === 0 ||
        low === 0 ||
        high < Math.max(open, close, low) ||
        low > Math.min(open, close)
      )
        throw new Error("Некоректні OHLC");
      rows.set(time, {
        time,
        open,
        high,
        low,
        close,
        volume: finite(candle.volume ?? 0, 0),
        ...(typeof candle.tradeCount === "number"
          ? { tradeCount: finite(candle.tradeCount, 0) }
          : {}),
      });
    }
    series[tf] = [...rows.values()].sort((a, b) => a.time - b.time);
    total += rows.size;
  }
  if (total > 4000 || !series[raw.timeframe as Timeframe]?.length)
    throw new Error("Немає свічок вибраного таймфрейму");
  if (
    !Array.isArray(raw.markers) ||
    raw.markers.length > 100 ||
    !Array.isArray(raw.drawings) ||
    raw.drawings.length > 200
  )
    throw new Error("Забагато позначок");
  const markerTypes = [
    "entry",
    "target",
    "stop_loss",
    "neckline",
    "resistance",
    "support",
    "custom",
    "pattern_point",
  ];
  const ids = new Set<string>();
  const markers: ChartMarkerInfo[] = raw.markers.map((m: any) => {
    const id = text(m.id, 120);
    if (!id || ids.has(id) || !markerTypes.includes(m.type))
      throw new Error("Некоректна позначка");
    ids.add(id);
    return {
      id,
      type: m.type,
      label: text(m.label, 160),
      price: finite(m.price, 0.000000000001),
      color: /^#[a-fA-F0-9]{6}$/.test(m.color) ? m.color : "#38bdf8",
      lineStyle: ["solid", "dashed", "dotted"].includes(m.lineStyle)
        ? m.lineStyle
        : "solid",
      lineWidth: Math.min(4, Math.max(1, Number(m.lineWidth) || 1)),
      ...(typeof m.time === "number" ? { time: finite(m.time, 1) } : {}),
      ...(m.shape &&
      ["circle", "square", "arrowUp", "arrowDown"].includes(m.shape)
        ? { shape: m.shape }
        : {}),
      ...(m.position && ["aboveBar", "belowBar", "inBar"].includes(m.position)
        ? { position: m.position }
        : {}),
      ...(m.notes ? { notes: text(m.notes, 500) } : {}),
    };
  });
  const drawingTypes = [
    "level",
    "trend",
    "ray",
    "rect",
    "fib",
    "profile",
    "text",
    "ruler",
  ];
  const drawingIds = new Set<string>();
  const drawings: HookChartDrawing[] = raw.drawings.map((d: any) => {
    if (
      !drawingTypes.includes(d.type) ||
      !Array.isArray(d.pts) ||
      !d.pts.length ||
      d.pts.length > 2
    )
      throw new Error("Некоректний малюнок");
    const rawId = text(d.id, 160);
    const prefix = raw.symbol + ":";
    const id = rawId.startsWith(prefix)
      ? rawId
      : prefix + rawId.slice(0, 160 - prefix.length);
    if (!rawId || drawingIds.has(id))
      throw new Error("Некоректний ідентифікатор малюнка");
    drawingIds.add(id);
    return {
      id,
      type: d.type,
      text: text(d.text, 500),
      pts: d.pts.map((p: any) => ({ t: finite(p.t, 1), p: finite(p.p, 0) })),
    };
  });
  return {
    version: 1,
    symbol: raw.symbol,
    exchange: raw.exchange,
    marketType: raw.marketType,
    timeframe: raw.timeframe,
    capturedAt,
    cutoff,
    series,
    markers,
    drawings,
    ...(raw.viewport &&
    Number.isFinite(raw.viewport.from) &&
    Number.isFinite(raw.viewport.to) &&
    raw.viewport.to > raw.viewport.from
      ? { viewport: { from: raw.viewport.from, to: raw.viewport.to } }
      : {}),
  };
}

/** Only coarser candles can be derived. Never invent finer-grained history. */
export function chartCandles(
  document: ChartDocument,
  timeframe: Timeframe,
): Kline[] | null {
  if (document.series[timeframe]?.length) return document.series[timeframe]!;
  const sourceTf = COMMUNITY_TIMEFRAMES.find(
    (tf) =>
      TF_SECONDS[tf] < TF_SECONDS[timeframe] && document.series[tf]?.length,
  );
  if (!sourceTf) return null;
  const rows = document.series[sourceTf]!;
  const step = TF_SECONDS[timeframe];
  const groups = new Map<number, { candle: Kline; times: number[] }>();
  for (const row of rows) {
    const time = Math.floor(row.time / step) * step;
    // Do not label a truncated first coarse bar as a complete historical bar.
    if (time < rows[0].time) continue;
    const entry = groups.get(time);
    if (!entry)
      groups.set(time, { candle: { ...row, time }, times: [row.time] });
    else {
      const current = entry.candle;
      current.high = Math.max(current.high, row.high);
      current.low = Math.min(current.low, row.low);
      current.close = row.close;
      current.volume += row.volume;
      entry.times.push(row.time);
    }
  }
  const sourceStep = TF_SECONDS[sourceTf];
  return [...groups.values()]
    .filter((group) => {
      const last = Math.min(
        group.candle.time + step - sourceStep,
        Math.floor(document.cutoff / sourceStep) * sourceStep,
      );
      const expected = Math.floor((last - group.candle.time) / sourceStep) + 1;
      return (
        group.times.length === expected &&
        group.times.every(
          (time, index) => time === group.candle.time + index * sourceStep,
        )
      );
    })
    .map((group) => group.candle);
}

export function moveChartMarker(
  marker: ChartMarkerInfo,
  price: number,
  time?: number,
): ChartMarkerInfo {
  return {
    ...marker,
    price,
    ...(marker.time !== undefined && time !== undefined ? { time } : {}),
  };
}
