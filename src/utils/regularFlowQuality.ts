import type {
  ConfluenceComponent, DetectedFormation, ExchangeId, Kline, MarketType, RegularIndicatorValues,
} from '../types';
import { REGULAR_OI_REASON_UK } from './regularOIHistory';

/**
 * Standard-mode 100-point rubric:
 * 72 points for geometry/structure; 13 for verified OI/delta/CVD; 15 for
 * round levels, real book walls, RSI, ATR stop sizing and breakout RVOL.
 * The added ATR/RVOL contributions are deliberately tiny (2 + 1) because
 * volatility and volume already exist in the structural rubric.
 * CVD is weighted less than last-candle delta because they are correlated.
 *
 * Early W/M deliberately never calls this module.
 */
export const REGULAR_BASE_QUALITY_WEIGHTS = {
  formation: 12,
  extremeLocation: 8,
  trigger: 16,
  retest: 7,
  volume: 5,
  volatility: 3,
  level: 6,
  riskReward: 8,
  dataQuality: 7,
} as const;

export const REGULAR_FLOW_QUALITY_WEIGHTS = {
  openInterest: 5,
  delta: 5,
  cvd20: 3,
} as const;

export const REGULAR_TECHNICAL_QUALITY_WEIGHTS = {
  roundNumber: 4,
  density: 5,
  rsi: 3,
  atr: 2,
  rvol: 1,
} as const;

const BASE_AVAILABLE_MAX = 72;
const fullTotal = Object.values(REGULAR_BASE_QUALITY_WEIGHTS).reduce((a,b) => a+b, 0)
  + Object.values(REGULAR_FLOW_QUALITY_WEIGHTS).reduce((a,b) => a+b, 0)
  + Object.values(REGULAR_TECHNICAL_QUALITY_WEIGHTS).reduce((a,b) => a+b, 0);
if (fullTotal !== 100) throw new Error('Ordinary formation signal quality rubric must sum to 100');

type FlowMetric = keyof typeof REGULAR_FLOW_QUALITY_WEIGHTS;
type TechnicalMetric = keyof typeof REGULAR_TECHNICAL_QUALITY_WEIGHTS;
export type RegularFlowStatus = 'supported' | 'contradicted' | 'mixed' | 'unavailable';

export interface RegularFlowSummary {
  status: RegularFlowStatus;
  available: number;
  supportive: number;
  conflicting: number;
  /** Counts correlated Binance delta + CVD as ONE independent confirmation. */
  independentSupport: number;
  /** Base validation remains authoritative; positive order flow cannot create a breakout. */
  entryConfirmedWithFlow: boolean;
  /** Two strongly opposing Binance taker-flow measurements block confirmation. */
  entryBlockedByFlow: boolean;
}

const round1 = (n: number) => Number(n.toFixed(1));
const finite = (n: unknown): n is number => typeof n === 'number' && Number.isFinite(n);
const qualityGrade = (score: number): 'A+'|'A'|'B'|'C'|'D' =>
  score >= 90 ? 'A+' : score >= 82 ? 'A' : score >= 72 ? 'B' : score >= 60 ? 'C' : 'D';

function row(
  score: number, max: number, evidence: string, available: boolean,
  stronglyOpposite = false,
): ConfluenceComponent {
  return {
    score: available ? round1(Math.max(0, Math.min(max, score))) : 0,
    max, available, evidence,
    status: !available ? 'MISSING'
      : stronglyOpposite ? 'CONFLICT'
      : score >= max * .8 ? 'CONFIRMED'
      : score > 0 ? 'PARTIAL' : 'MISSING',
  };
}

/**
 * Set points only for authentic data on its supported market. Missing is NOT
 * the same as a verified negative value and is omitted from the denominator.
 *
 * The displayed score remains 0..100 (normalised by available evidence), so
 * Bybit and spot coins do not lose points merely because a data feed is absent.
 * Display the raw 0..max subscores and the available denominator separately.
 */
export function scoreRegularFlowQuality(
  formation: DetectedFormation,
  indicators: RegularIndicatorValues | undefined,
  exchange: ExchangeId,
  marketType: MarketType,
  closedCandles: readonly Kline[],
  /** True only if this specific formation's level had a valid live depth snapshot. */
  densityChecked = false,
  /** Re-score an ordinary server result after its missing OI arrives via browser. */
  refreshVerifiedOi = false,
): DetectedFormation {
  const validation = formation.validation;
  if (!validation?.confluence || (validation.confluence.flow && !refreshVerifiedOi)) return formation;
  const original = validation.confluence;
  const base = original.components;
  const direction = formation.bias === 'bullish' ? 1 : formation.bias === 'bearish' ? -1 : 0;
  const hasDirection = direction !== 0;

  // The most recent *closed* candle is only supporting price context: OI
  // growth by itself does not reveal whether longs or shorts were opened.
  const last = closedCandles.at(-1), previous = closedCandles.at(-2);
  const directionalClose = !!last && !!previous && direction !== 0
    && (last.close - previous.close) * direction > 0;
  const oi = marketType === 'futures' && hasDirection && finite(indicators?.oiChangePct)
    ? indicators.oiChangePct : null;
  const delta = exchange === 'binance' && hasDirection && finite(indicators?.deltaPct)
    ? indicators.deltaPct * direction : null;
  const cvd = exchange === 'binance' && hasDirection && finite(indicators?.cvd20Pct)
    ? indicators.cvd20Pct * direction : null;

  const oiSupport = oi !== null && oi >= .3 && directionalClose && validation.breakoutConfirmed;
  const deltaSupport = delta !== null && delta >= 5;
  const cvdSupport = cvd !== null && cvd >= 2;
  const oiAgainst = oi !== null && oi <= -1;
  const deltaAgainst = delta !== null && delta <= -20;
  const cvdAgainst = cvd !== null && cvd <= -5;

  const flowRows: Record<FlowMetric, ConfluenceComponent> = {
    openInterest: row(oi === null ? 0
      : oiSupport ? (oi >= 1 ? 5 : 3)
      : oi >= 0 ? 1 : 0, 5,
      oi === null
        ? `OI: ${indicators?.oiAvailability
          ? REGULAR_OI_REASON_UK[indicators.oiAvailability]
          : marketType === 'spot' ? REGULAR_OI_REASON_UK.spot : 'немає достовірних даних'}`
        : `OI ${oi > 0 ? '+' : ''}${oi.toFixed(2)}% за TF · ${oiSupport
          ? 'зростання позицій супроводжує підтверджений рух'
          : 'OI сам по собі не доводить напрямок нових позицій'} · джерело: ${indicators?.oiSource === 'browser' ? 'браузер' : indicators?.oiSource === 'server' ? 'сервер' : 'біржа'}`, oi !== null, oiAgainst),
    delta: row(delta === null ? 0
      : delta >= 20 ? 5 : delta >= 5 ? 4 : delta > 0 ? 2 : delta > -5 ? 1 : 0, 5,
      delta === null ? 'Дельта: немає верифікованого taker buy/sell (доступна лише Binance)'
        : `Дельта ${indicators!.deltaPct! > 0 ? '+' : ''}${indicators!.deltaPct!.toFixed(2)}% за останню закриту свічку · ${delta > 0 ? 'за напрямком' : 'проти напрямку'} формації`, delta !== null, deltaAgainst),
    cvd20: row(cvd === null ? 0
      : cvd >= 10 ? 3 : cvd >= 2 ? 2 : cvd > 0 ? 1 : 0, 3,
      cvd === null ? 'CVD20: немає 20 послідовних свічок Binance з taker buy/sell'
        : `CVD20 ${indicators!.cvd20Pct! > 0 ? '+' : ''}${indicators!.cvd20Pct!.toFixed(2)}% за 20 закритих свічок · ${cvd > 0 ? 'за напрямком' : 'проти напрямку'} формації`, cvd !== null, cvdAgainst),
  };


  // A round number is a static price-location condition; it does not prove
  // a standing order. Order-book density is a separate live snapshot signal.
  const roundContext = formation.roundNumberContext;
  const roundAvailable = !!roundContext
    && finite(roundContext.distancePct) && finite(roundContext.step) && roundContext.step > 0;
  const roundDetected = roundAvailable && roundContext!.detected === true;
  const roundStrength = roundDetected && finite(roundContext!.strength) ? roundContext!.strength : 0;
  const matchedSide = direction === 1 ? 'BID' : direction === -1 ? 'ASK' : null;
  const verifiedDensity = roundDetected && roundContext!.densityConfirmed === true
    && !!matchedSide && roundContext!.side === matchedSide
    && finite(roundContext!.densityUsd) && roundContext!.densityUsd >= 5_000
    && roundStrength >= 70;
  // Failure to fetch an order book is unknown, not evidence of no liquidity.
  // A verified book with no wall counts as 0, not missing.
  const densityAvailable = roundDetected && (densityChecked || verifiedDensity);
  const rsi = finite(indicators?.rsi14)
    && indicators.rsi14 >= 0 && indicators.rsi14 <= 100 ? indicators.rsi14 : null;
  const atrPct = finite(indicators?.atrPct) && indicators.atrPct > 0
    ? indicators.atrPct : null;
  const stopDistancePct = finite(formation.levels.entryPrice)
    && formation.levels.entryPrice > 0 && finite(formation.levels.stopLossPrice)
    ? Math.abs(formation.levels.entryPrice - formation.levels.stopLossPrice)
      / formation.levels.entryPrice * 100 : null;
  const targetDistancePct = finite(formation.levels.entryPrice)
    && formation.levels.entryPrice > 0 && finite(formation.levels.targetPrice)
    ? Math.abs(formation.levels.targetPrice - formation.levels.entryPrice)
      / formation.levels.entryPrice * 100 : null;
  const atrGeometryAvailable = atrPct !== null && stopDistancePct !== null
    && targetDistancePct !== null && targetDistancePct > 0
    && stopDistancePct > 0;
  const stopInAtr = atrGeometryAvailable ? stopDistancePct! / atrPct! : null;
  const targetInAtr = atrGeometryAvailable ? targetDistancePct! / atrPct! : null;
  const rvol = validation.breakoutConfirmed && finite(validation.volumeRatio)
    && validation.volumeRatio >= 0 ? validation.volumeRatio : null;
  const rvolAvailable = finite(validation.volumeRatio) && validation.volumeRatio >= 0;

  // RSI describes directional momentum *and* overextension; neither an
  // overbought bullish nor oversold bearish reading earns maximum points.
  const rsiScore = rsi === null ? 0 : direction === 1
    ? rsi >= 55 && rsi <= 68 ? 3 : rsi >= 50 && rsi <= 75 ? 2
      : rsi >= 42 && rsi < 50 ? 1 : 0
    : direction === -1
      ? rsi >= 32 && rsi <= 45 ? 3 : rsi >= 25 && rsi <= 50 ? 2
        : rsi > 50 && rsi <= 58 ? 1 : 0 : 0;

  const technicalRows: Record<TechnicalMetric, ConfluenceComponent> = {
    roundNumber: row(roundStrength >= 85 ? 4 : roundStrength >= 70 ? 3
      : roundStrength > 0 ? 2 : 0, 4,
      !roundAvailable ? 'Круглий рівень: немає валідного контексту свічок'
        : roundDetected
          ? `Круглий рівень ${roundContext!.level} · відстань ${roundContext!.distancePct.toFixed(3)}% · сила ${roundStrength}/100 (без підтвердження стаканом)`
          : `Круглий рівень поза допустимою зоною · відстань ${roundContext!.distancePct.toFixed(3)}%`,
      roundAvailable),
    density: row(verifiedDensity
      ? roundStrength >= 85 && roundContext!.densityUsd! >= 15_000 ? 5
        : roundStrength >= 75 ? 4 : 3 : 0, 5,
      !roundDetected ? 'Щільність: немає релевантного круглого рівня'
        : !densityAvailable ? 'Щільність: стакан не перевірено / API недоступний'
          : verifiedDensity
            ? `Верифікована ${matchedSide}-заявка ${roundContext!.densityUsd!.toFixed(0)} · знімок стакана, може зникнути`
            : 'Рівень перевірено у стакані: потрібної BID/ASK щільності немає',
      densityAvailable),
    rsi: row(rsiScore, 3, rsi === null
      ? 'RSI14: немає коректних закритих свічок'
      : `RSI14 ${rsi.toFixed(1)} · ${direction === 1 ? 'LONG' : 'SHORT'} · оцінка сили без переслідування крайніх зон`,
      rsi !== null && hasDirection),
    atr: row(!atrGeometryAvailable ? 0
      : stopInAtr! >= .65 && stopInAtr! <= 3.2 && targetInAtr! <= 3.2
        ? 2 : stopInAtr! >= .45 && stopInAtr! <= 4 && targetInAtr! <= 4 ? 1 : 0, 2,
      atrGeometryAvailable
        ? `ATR14 ${atrPct!.toFixed(2)}% · SL ${stopInAtr!.toFixed(2)} ATR · TP ${targetInAtr!.toFixed(2)} ATR (перевірка адекватності ризику)`
        : 'ATR14: немає надійних свічок чи коректного SL/TP',
      atrGeometryAvailable),
    rvol: row(rvol !== null
      ? rvol >= 1.5 ? 1 : rvol >= 1.2 ? .5 : 0 : 0, 1,
      rvol === null ? 'RVOL: немає підтвердженого пробою з достовірним обсягом'
        : `RVOL ${rvol.toFixed(2)}× · окрема невелика вага, оскільки volume вже оцінює пробій`,
      rvolAvailable),
  };

  const components = {
    ...Object.fromEntries(Object.entries(REGULAR_BASE_QUALITY_WEIGHTS).map(([key, max]) => {
      const originalRow = base[key as keyof typeof REGULAR_BASE_QUALITY_WEIGHTS];
      const fraction = originalRow.max > 0 ? originalRow.score / originalRow.max : 0;
      return [key, { ...originalRow, score: round1(Math.min(max, Math.max(0, fraction * max))), max,
        available: true }];
    })) as typeof base,
    ...flowRows,
    ...technicalRows,
  };
  const availableTechnicalMax = (Object.keys(technicalRows) as TechnicalMetric[])
    .filter(key => technicalRows[key].available).reduce((sum, key) => sum + technicalRows[key].max, 0);
  const availableFlowMax = (Object.keys(flowRows) as FlowMetric[])
    .filter(key => flowRows[key].available).reduce((sum, key) => sum + flowRows[key].max, 0);
  const availableMax = BASE_AVAILABLE_MAX + availableFlowMax + availableTechnicalMax;
  const rawTotal = round1(Object.values(components).reduce((sum, item) => sum + item.score, 0));
  const total = round1(Math.min(100, Math.max(0, rawTotal / availableMax * 100)));

  const available = [oi,delta,cvd].filter(x => x !== null).length;
  const supportive = Number(oiSupport) + Number(deltaSupport) + Number(cvdSupport);
  const conflicting = Number(oiAgainst) + Number(deltaAgainst) + Number(cvdAgainst);
  const independentSupport = Number(oiSupport) + Number(deltaSupport || cvdSupport);
  const entryBlockedByFlow = deltaAgainst && cvdAgainst;
  const flow: RegularFlowSummary = {
    status: !available ? 'unavailable'
      : entryBlockedByFlow ? 'contradicted'
      : supportive >= 2 ? 'supported' : 'mixed',
    available, supportive, conflicting, independentSupport,
    entryConfirmedWithFlow: validation.passed && supportive >= 2 && !entryBlockedByFlow,
    entryBlockedByFlow,
  };

  // Do not manufacture an entry with flow indicators if the structure,
  // breakout, RVOL or risk/reward had not passed.
  const passed = validation.passed && !entryBlockedByFlow;
  const label = entryBlockedByFlow && validation.passed && formation.status !== 'target_reached'
    ? formation.statusLabel.replace(/ · ПІДТВЕРДЖЕНО(?= · кругле число$|$)/u,
      ' · сильна розбіжність дельти/CVD') : formation.statusLabel;
  const rejectionReasons = entryBlockedByFlow
    ? [...validation.rejectionReasons, 'Сильна протилежна дельта і CVD20: вхід не підтверджено потоком']
    : [...validation.rejectionReasons];

  return {
    ...formation, confidence: Math.round(total), statusLabel: label,
    validation: {
      ...validation, passed, rejectionReasons,
      confluence: {
        ...original, components, total, grade: qualityGrade(total),
        rawTotal, availableMax, flow,
        independentConfirmations: Math.max(0, original.independentConfirmations
          - (original.flow?.independentSupport ?? 0)) + independentSupport,
        conflicts: entryBlockedByFlow
          ? [...original.conflicts, 'Сильна розбіжність taker delta та CVD20']
          : [...original.conflicts],
        missing: [...original.missing],
        notes: [...original.notes.filter(note =>
          !original.flow || (!note.startsWith('Рейтинг нормовано:')
            && note !== 'Потік оцінюється лише за перевіреними даними; OI не визначає сторону позицій'
            && note !== 'ATR/RVOL вже частково враховані у volatility/volume; їхні додаткові ваги обмежені до 2 і 1'
            && note !== 'Кругле число не доводить наявність щільності; стакан — одноразовий знімок')),
          'Потік оцінюється лише за перевіреними даними; OI не визначає сторону позицій',
          'ATR/RVOL вже частково враховані у volatility/volume; їхні додаткові ваги обмежені до 2 і 1',
          'Кругле число не доводить наявність щільності; стакан — одноразовий знімок',
          `Рейтинг нормовано: ${rawTotal}/${availableMax} доступних балів = ${total}/100`],
      },
    },
  };
}
