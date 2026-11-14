import test from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync, verify } from "node:crypto";
import { readFileSync } from "node:fs";
import { archivedScorePayload, issueArchivedScoreProof } from "../server/archiveQualityProof";

const routes = readFileSync(new URL("../server/pgIdentityRoutes.ts", import.meta.url), "utf8");
const db = readFileSync(new URL("../server/pgIdentity.ts", import.meta.url), "utf8");
const modal = readFileSync(new URL("../src/components/ArchiveModal.tsx", import.meta.url), "utf8");
const now = Date.UTC(2026, 10, 14, 11, 20);

const weights: Record<string, number> = {
  formation:12, extremeLocation:8, trigger:16, retest:7,
  volume:5, volatility:3, level:6, riskReward:8, dataQuality:7,
  openInterest:5, delta:5, cvd20:3,
  roundNumber:4, density:5, rsi:3, atr:2, rvol:1,
};
const adjusted: Record<string, number> = {
  formation:10, trigger:12, retest:3, density:0, rvol:0, rsi:1,
};
const components = Object.fromEntries(Object.entries(weights).map(([key,max]) => [
  key, { score: adjusted[key] ?? max, max, available: true },
]));
function fixture() {
  return {
    id: "arch_btc_formation_001", symbol: "BTCUSDT",
    exchange: "binance", marketType: "futures", timeframe: "15m",
    confidence: 82, entryPrice: 100, stopLossPrice: 95, targetPrice: 112,
    formation: {
      patternKey: "double-bottom", bias: "bullish", confidence: 82,
      detectedAt: now - 60_000,
      levels: { entryPrice: 100, stopLossPrice: 95, targetPrice: 112 },
      validation: { confluence: {
        total: 82, grade: "A", rawTotal: 82, availableMax: 100, components,
      } },
    },
  };
}

test("h00k exporter signs only consistent archived STANDARD pattern scores, never manual placeholders", () => {
  const p = archivedScorePayload(fixture(), now);
  assert.deepEqual([
    p.version, p.issuer, p.purpose, p.rubric, p.symbol, p.exchange,
    p.marketType, p.timeframe, p.score, p.entry, p.stop, p.target,
  ], [1,"h00k.top","archive-score-record","regular-flow-72-13-15-v1","BTCUSDT","binance","futures","15m",82,100,95,112]);
  assert.equal(p.issuedAt, now);
  assert.equal(p.expiresAt - p.issuedAt, 600_000);
  assert.equal(p.assessedAt, now - 60_000);
  assert.equal(JSON.stringify(p).includes("userId"), false);
  assert.throws(() => archivedScorePayload({
    ...fixture(), formation: { ...fixture().formation, patternKey:"manual" },
  }, now), /повної узгодженої/);
  assert.throws(() => archivedScorePayload({
    ...fixture(), formation: { ...fixture().formation, validation: undefined },
  }, now));
  assert.throws(() => archivedScorePayload({ ...fixture(), confidence: 99 }, now));
  assert.throws(() => archivedScorePayload({
    ...fixture(), formation: { ...fixture().formation,
      validation: { confluence: { total: 82, grade: "A", rawTotal: 81,
        availableMax: 100, components } } },
  }, now), /повної узгодженої/);
  assert.throws(() => archivedScorePayload({
    ...fixture(), formation: { ...fixture().formation,
      validation: { confluence: { total: 82, grade: "A", rawTotal: 82,
        availableMax: 100, components: { ...components, density: { score: 5, max: 5, available: false } } } } },
  }, now), /повної узгодженої/);
  assert.throws(() => archivedScorePayload({ ...fixture(), entryPrice: 101 }, now));
  assert.throws(() => archivedScorePayload({
    ...fixture(), formation: { ...fixture().formation, detectedAt: now + 180_000 },
  }, now));
});

test("Ed25519 score archive export is domain-separated, short-lived, and disabled without a key", () => {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const privateBase64 = Buffer.from(privateKey.export({ type: "pkcs8", format: "pem" })).toString("base64");
  const proof = issueArchivedScoreProof(fixture(), privateBase64, now);
  const message = Buffer.from("h00k-score-archive:v1\n" + JSON.stringify(proof.payload));
  assert.equal(verify(null, message, publicKey, Buffer.from(proof.signature, "base64url")), true);
  assert.equal(verify(null, Buffer.from(JSON.stringify(proof.payload)), publicKey, Buffer.from(proof.signature, "base64url")), false);
  assert.throws(() => issueArchivedScoreProof(fixture(), undefined, now), /не налаштовано/);
  assert.throws(() => issueArchivedScoreProof(fixture(), "broken", now), /недоступний/);
});

test("screener export is explicit, authenticated, owner scoped and never changes market feeds", () => {
  assert.match(routes, /app\.get\('\/api\/account\/archive\/:id\/quality-proof', requirePostgresSession/);
  assert.match(routes, /rateLimit\(req, 'quality-proof-export', 10, 60_000, false\)/);
  assert.match(routes, /loadArchiveItem\(res\.locals\.userId, String\(req\.params\.id\)\)/);
  assert.match(routes, /issueArchivedScoreProof\(archive, process\.env\.H00K_QUALITY_SIGNING_KEY_B64\)/);
  assert.match(db, /WHERE user_id=\$1 AND id=\$2 LIMIT 1/);
  assert.match(modal, /handleCopyQualityProof\(item\.id, event\)/);
  assert.match(modal, /navigator\.clipboard\.writeText\(JSON\.stringify\(payload\.proof\)\)/);
  assert.match(modal, /Оцінка для Community/);
  assert.doesNotMatch(routes, /quality-proof.*\/api\/exchange|quality-proof.*subscribe/i);
});
