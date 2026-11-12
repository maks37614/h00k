import React, { useEffect, useState } from 'react';

interface MarketSentimentScaleProps {
  score: number;
  sentimentLabel: string;
}

/** Display only the score returned by /api/market/sentiment. */
export const clampSentimentScore = (score: number): number =>
  Number.isFinite(score) ? Math.min(100, Math.max(0, score)) : 0;

// Visual-only segments: the market score still comes from the existing API.
const SEGMENT_COLORS = [
  '#fb4c61',
  '#ff795e',
  '#ffa44f',
  '#ffde35',
  '#a4ed5b',
  '#33e8c4',
  '#16ca92',
  '#0f946e',
] as const;

/**
 * Always-visible, accessible fear → greed gauge. The neon score marker moves
 * with live API readings; the colored blocks are presentation only.
 */
export const MarketSentimentScale: React.FC<MarketSentimentScaleProps> = ({ score, sentimentLabel }) => {
  const actualScore = clampSentimentScore(score);
  const [displayScore, setDisplayScore] = useState(50);

  useEffect(() => {
    setDisplayScore(actualScore);
  }, [actualScore]);

  const markerPosition = Math.min(100, Math.max(0, displayScore));
  const activeSegment = Math.min(
    SEGMENT_COLORS.length - 1,
    Math.floor(displayScore / (100 / SEGMENT_COLORS.length)),
  );

  return (
    <div
      data-market-sentiment-scale
      className="min-w-0 flex-1 px-3 pb-2.5 pt-2 sm:px-4 sm:pb-3 md:py-2.5"
      role="meter"
      aria-label="Індекс настрою ринку: від страху до жадібності"
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={actualScore}
      aria-valuetext={`${actualScore} зі 100 — ${sentimentLabel}`}
    >
      <div className="relative py-1.5">
        <div className="grid grid-cols-8 gap-[4px] sm:gap-[5px]" aria-hidden="true">
          {SEGMENT_COLORS.map((color, index) => (
            <span
              key={color}
              data-market-sentiment-segment
              className={`h-[19px] min-w-0 rounded-[5px] shadow-[inset_0_1px_1px_rgba(255,255,255,0.15)] transition-[filter,box-shadow] duration-300 ${index === activeSegment ? 'brightness-110 ring-1 ring-white/40' : ''}`}
              style={{ backgroundColor: color }}
            />
          ))}
        </div>
        <div
          data-market-sentiment-marker
          className="pointer-events-none absolute top-1/2 z-10 flex h-[29px] min-w-[72px] -translate-x-1/2 -translate-y-1/2 items-center justify-center gap-0.5 rounded-[7px] border border-emerald-400 bg-[#091c24] px-2 font-mono text-[12px] font-bold text-emerald-300 shadow-[0_0_12px_rgba(16,235,192,0.65),inset_0_0_8px_rgba(16,235,192,0.12)] motion-safe:transition-[left] motion-safe:duration-1000 motion-safe:ease-out sm:text-[13px]"
          style={{ left: `clamp(36px, ${markerPosition}%, calc(100% - 36px))` }}
          aria-hidden="true"
        >
          <span>{Math.round(displayScore)}</span>
          <span className="text-slate-300">/100</span>
        </div>
      </div>
      <div className="mt-1 flex items-center justify-between gap-2 text-[10px] font-medium text-slate-300 sm:text-[11px]" aria-hidden="true">
        <span>Страх</span>
        <span>Нейтрально</span>
        <span>Жадібність</span>
      </div>
    </div>
  );
};
