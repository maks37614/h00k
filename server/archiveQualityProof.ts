import { createPrivateKey, sign } from "node:crypto";
import { AuthFailure } from "./pgIdentity";

/**
 * A signed record of what the authenticated user's h00k archive contained.
 * This is NOT independent verification of the client-generated scanner score.
 * The archive writer itself accepts user-submitted data.
 */
export type ArchivedScorePayload = {
  version: 1;
  issuer: "h00k.top";
  purpose: "archive-score-record";
  archiveId: string;
  symbol: string;
  exchange: "binance" | "bybit";
  marketType: "spot" | "futures";
  timeframe: "1m" | "5m" | "15m" | "1h" | "4h" | "1d";
  score: number;
  entry: number;
  stop: number;
  target: number;
  assessedAt: number;
  issuedAt: number;
  expiresAt: number;
};

export type SignedArchivedScore = {
  payload: ArchivedScorePayload;
  signature: string;
};

const validPrice = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value) && value > 0;

const gradeExpected = (total: number) =>
  total >= 90 ? "A+" : total >= 82 ? "A" : total >= 72 ? "B" : total >= 60 ? "C" : "D";

/** Only accept a complete historic confluence result, never a manual 0-score stub. */
export function archivedScorePayload(archive: any, now = Date.now()): ArchivedScorePayload {
  const formation = archive?.formation;
  const confluence = formation?.validation?.confluence;
  const total = confluence?.total;
  const archiveId = archive?.id;
  const assessedAt = formation?.detectedAt;
  if (typeof archiveId !== "string" || !/^[a-zA-Z0-9_-]{1,140}$/.test(archiveId) ||
      typeof archive.symbol !== "string" || !/^[A-Z0-9]{2,30}$/.test(archive.symbol) ||
      !["binance", "bybit"].includes(archive.exchange) ||
      !["spot", "futures"].includes(archive.marketType) ||
      !["1m","5m","15m","1h","4h","1d"].includes(archive.timeframe) ||
      typeof formation?.patternKey !== "string" || formation.patternKey === "manual" ||
      formation.patternKey.length > 100 || formation.bias === "neutral" ||
      typeof total !== "number" || !Number.isFinite(total) || total < 0 || total > 100 ||
      !Number.isInteger(formation.confidence) || Math.abs(formation.confidence - Math.round(total)) > 1 ||
      !Number.isInteger(archive.confidence) || Math.abs(archive.confidence - Math.round(total)) > 1 ||
      confluence.grade !== gradeExpected(total) ||
      !confluence.components || typeof confluence.components !== "object" ||
      !validPrice(archive.entryPrice) || !validPrice(archive.stopLossPrice) || !validPrice(archive.targetPrice) ||
      formation.levels?.entryPrice !== archive.entryPrice ||
      formation.levels?.stopLossPrice !== archive.stopLossPrice ||
      formation.levels?.targetPrice !== archive.targetPrice ||
      typeof assessedAt !== "number" || !Number.isSafeInteger(assessedAt) ||
      assessedAt <= 0 || assessedAt > now + 60_000) {
    throw new AuthFailure(422, "Цей архів не містить повної узгодженої оцінки стандартної формації.", "QUALITY_NOT_AVAILABLE");
  }
  // These values are from the user's saved archive, not a server rerun.
  return {
    version: 1, issuer: "h00k.top", purpose: "archive-score-record",
    archiveId, symbol: archive.symbol, exchange: archive.exchange,
    marketType: archive.marketType, timeframe: archive.timeframe,
    score: total, entry: archive.entryPrice, stop: archive.stopLossPrice,
    target: archive.targetPrice, assessedAt, issuedAt: now,
    expiresAt: now + 10 * 60_000,
  };
}

export function issueArchivedScoreProof(archive: any, encodedPrivateKey: string | undefined,
  now = Date.now()): SignedArchivedScore {
  if (!encodedPrivateKey) {
    throw new AuthFailure(503, "Підписаний експорт оцінки поки не налаштовано.", "QUALITY_PROOF_DISABLED");
  }
  const payload = archivedScorePayload(archive, now);
  let key;
  try {
    key = createPrivateKey(Buffer.from(encodedPrivateKey, "base64"));
    if (key.asymmetricKeyType !== "ed25519") throw new Error("Unsupported key");
  } catch {
    throw new AuthFailure(503, "Підписаний експорт оцінки недоступний.", "QUALITY_PROOF_DISABLED");
  }
  const bytes = Buffer.from("h00k-score-archive:v1\n" + JSON.stringify(payload), "utf8");
  return { payload, signature: sign(null, bytes, key).toString("base64url") };
}
