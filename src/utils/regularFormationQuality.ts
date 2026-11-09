import type { ConfluenceComponent, DetectedFormation, Kline } from '../types';

const positive = (n: number | undefined): n is number =>
  typeof n === 'number' && Number.isFinite(n) && n > 0;
const distancePct = (a: number, b: number) => Math.abs(a - b) / Math.max(b, 1e-12) * 100;

function component(score: number, max: number, evidence: string): ConfluenceComponent {
  const safe = Math.max(0, Math.min(max, score));
  return {
    score: Number(safe.toFixed(1)), max, evidence,
    status: safe >= max * .8 ? 'CONFIRMED' : safe > 0 ? 'PARTIAL' : 'MISSING',
  };
}

function grade(total: number): 'A+' | 'A' | 'B' | 'C' | 'D' {
  return total >= 90 ? 'A+' : total >= 82 ? 'A' : total >= 72 ? 'B' : total >= 60 ? 'C' : 'D';
}

/**
 * Correct NORMAL-mode confluence only. Volume confirms the breakout candle,
 * not an unrelated last candle. Retest reuses the actual breakout level
 * (neckline/resistance/support), and a far-away unrelated level cannot earn
 * maximum location points.
 */
export function reassessRegularFormationQuality(
  candles: Kline[], formation: DetectedFormation,
): DetectedFormation {
  const v = formation.validation;
  if (!v?.confluence || formation.bias === 'neutral' || candles.length < 25) return formation;
  const breakoutIndex = v.breakoutConfirmed ? v.breakoutIndex : undefined;
  const index = breakoutIndex !== undefined && breakoutIndex >= 1 && breakoutIndex < candles.length
    ? breakoutIndex : candles.length - 1;
  const reference = candles.slice(Math.max(0, index - 20), index);
  const mean = reference.length
    ? reference.reduce((total, bar) => total + bar.volume, 0) / reference.length : 0;
  const volumeRatio = mean > 0 ? candles[index].volume / mean : 0;
  const isBreakout = v.breakoutConfirmed && breakoutIndex !== undefined;
  const activeVolume = isBreakout && volumeRatio >= 1.15;
  const volumeTier = volumeRatio >= 2 ? 10 : volumeRatio >= 1.5 ? 8
    : volumeRatio >= 1.2 ? 6 : volumeRatio >= 1 ? 3 : 0;
  const volumeScore = isBreakout ? volumeTier : Math.min(volumeTier, 3);

  const bullish = formation.bias === 'bullish';
  const level = formation.levels.necklinePrice
    ?? (bullish ? formation.levels.resistancePrice : formation.levels.supportPrice)
    ?? formation.levels.entryPrice;
  const proximity = positive(level) ? distancePct(candles[candles.length - 1].close, level) : 999;
  const levelScore = proximity <= .5 ? 10 : proximity <= 1 ? 8
    : proximity <= 2 ? 6 : proximity <= 4.5 ? 3 : 0;

  const atr = v.atrPct / 100 * candles[candles.length - 1].close;
  const tol = Math.max(atr * .35, level * .0015);
  const retest = !!isBreakout && positive(level)
    && candles.slice(breakoutIndex! + 1).some(c => bullish
      ? c.low <= level + tol && c.close > level
      : c.high >= level - tol && c.close < level);

  const components = {
    ...v.confluence.components,
    retest: component(retest ? 10 : isBreakout ? 4 : 0, 10,
      retest ? 'Після пробою ціна перевірила той самий рівень і закрилася на правильному боці'
        : isBreakout ? 'Пробій без підтвердженого ретесту рівня' : 'Ретест потребує пробою'),
    volume: component(volumeScore, 10,
      `RVOL ${volumeRatio.toFixed(2)}x · ${isBreakout ? 'свічка пробою' : 'без підтвердженого пробою'}`),
    level: component(levelScore, 10,
      `Відстань до рівня ${(bullish ? 'опору' : 'підтримки')} / шиї: ${proximity.toFixed(2)}%`),
  };
  const total = Number(Object.values(components).reduce((sum, row) => sum + row.score, 0).toFixed(1));
  const missing = v.confluence.missing.filter(x =>
    x !== 'Retest рівня' && x !== 'Підтвердження обсягом');
  if (isBreakout && !retest) missing.push('Retest рівня');
  if (!activeVolume) missing.push('Підтвердження обсягом свічки пробою');
  const notes = v.confluence.notes.filter(x => !x.startsWith('Breakout підтверджено ретестом'));
  if (retest) notes.push('Breakout підтверджено ретестом того самого рівня');
  const rr = v.riskReward;
  const confirmations = [
    isBreakout, retest, activeVolume && volumeRatio >= 1.2,
    !!formation.extremeContext?.aligned, proximity <= 2, rr >= 2,
  ].filter(Boolean).length;
  // A breakout entry is not executable at its historical trigger if the
  // market has run far away before the user views the setup.
  const extendedEntry = isBreakout && !retest && atr > 0
    && Math.abs(candles[candles.length - 1].close - formation.levels.entryPrice) > atr * 1.5;
  const passed = v.confirmed && activeVolume && v.filters.volatility
    && proximity <= 4.5 && v.filters.structure && !extendedEntry;
  const reasons = v.rejectionReasons.filter(x => x !== 'Обсяг не підтверджує рух'
    && x !== 'Немає близького ключового рівня');
  if (!activeVolume) reasons.push('Обсяг свічки пробою не підтверджений');
  if (proximity > 4.5) reasons.push('Немає близького рівня пробою');
  if (extendedEntry) reasons.push('Ціна відійшла від входу більш ніж на 1.5 ATR: очікуйте ретест');
  const cleanLabel = formation.statusLabel
    .replace(/ · кругле число$/u, '')
    .replace(/(?: · (?:ПІДТВЕРДЖЕНО|очікування пробою|очікування підтвердження))+$/gu, '');
  const statusLabel = formation.status === 'target_reached'
    ? 'Ціль досягнуто (TP)'
    : cleanLabel.startsWith('Вхід скасовано:') ? cleanLabel
      : `${cleanLabel} · ${extendedEntry ? 'ціна далеко від входу, очікуйте ретест'
        : passed ? 'ПІДТВЕРДЖЕНО' : isBreakout ? 'очікування підтвердження' : 'очікування пробою'}`;
  return {
    ...formation,
    confidence: Math.round(total),
    statusLabel: formation.roundNumberContext?.detected ? statusLabel + ' · кругле число' : statusLabel,
    validation: {
      ...v, passed, volumeRatio: Number(volumeRatio.toFixed(3)),
      nearbyLevelDistancePct: Number(proximity.toFixed(3)),
      filters: { ...v.filters, volume: activeVolume, nearbyLevel: proximity <= 4.5 },
      rejectionReasons: reasons,
      confluence: { ...v.confluence, total, grade: grade(total),
        components, missing, notes, independentConfirmations: confirmations },
    },
  };
}
