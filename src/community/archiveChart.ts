import type { ArchivedFormation, DetectedFormation } from "../types";
import { normalizeChartDocument, type ChartDocument } from "./chartDocument";
import { apiJson } from "../utils/apiFetch";

export async function saveChartArchive(
  input: ChartDocument,
  userId: string,
  notes = "",
  sourceChartId?: string,
): Promise<ArchivedFormation> {
  const d = normalizeChartDocument(input),
    now = Date.now(),
    last = d.series[d.timeframe]!.at(-1)!.close;
  const level = (type: string) =>
    d.markers.find((m) => m.type === type)?.price ?? last;
  const entry = level("entry"),
    target = level("target"),
    stop = level("stop_loss");
  const formation: DetectedFormation = {
    id: "manual-" + crypto.randomUUID(),
    patternKey: "manual",
    name: "Власний розбір",
    nameEn: "Personal chart analysis",
    category: "reversal",
    bias: "neutral",
    confidence: 0,
    status: "forming",
    statusLabel: "Авторський розбір",
    description: notes,
    levels: { entryPrice: entry, targetPrice: target, stopLossPrice: stop },
    riskRewardRatio:
      entry !== stop ? Math.abs(target - entry) / Math.abs(entry - stop) : 0,
    potentialProfitPct: (Math.abs(target - entry) / entry) * 100,
    potentialRiskPct: (Math.abs(entry - stop) / entry) * 100,
    detectedAt: now,
  };
  const item: ArchivedFormation = {
    id: "arch_" + crypto.randomUUID(),
    userId,
    symbol: d.symbol,
    baseAsset: d.symbol.replace(/(USDT|USDC|BTC|ETH)$/, ""),
    quoteAsset: d.symbol.endsWith("USDC") ? "USDC" : "USDT",
    exchange: d.exchange,
    marketType: d.marketType,
    timeframe: d.timeframe,
    formationName: formation.name,
    bias: "neutral",
    entryPrice: entry,
    targetPrice: target,
    stopLossPrice: stop,
    savedPrice: last,
    formation,
    markers: d.markers,
    chartDocument: d,
    ...(sourceChartId ? { sourceChartId } : {}),
    chartParams: {
      timeframe: d.timeframe,
      historyLimit: d.series[d.timeframe]!.length,
      lastClosePrice: last,
    },
    notes,
    createdAt: new Date(now).toISOString(),
    savedAtTimestamp: now,
  };
  const data = await apiJson("/api/community/archives", {
    method: "POST",
    body: JSON.stringify(item),
  });
  window.dispatchEvent(new Event("h00k:archive-saved"));
  return data.item;
}
