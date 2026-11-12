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
  '#ff294e',
  '#f43f5e',
  '#fb5263',
  '#ffb02e',
  '#ffdf40',
  '#6be785',
  '#1ad6a8',
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
  // Keep the marker's border, glow, and score color in sync with the current zone.
  const markerAccent = SEGMENT_COLORS[activeSegment];

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
          className="pointer-events-none absolute top-1/2 z-10 flex h-[29px] min-w-[72px] -translate-x-1/2 -translate-y-1/2 items-center justify-center gap-0.5 rounded-[7px] border bg-[#091c24] px-2 font-mono text-[12px] font-bold motion-safe:transition-[left,border-color,color,box-shadow] motion-safe:duration-1000 motion-safe:ease-out sm:text-[13px]"
          style={{
            left: `clamp(36px, ${markerPosition}%, calc(100% - 36px))`,
            borderColor: markerAccent,
            color: markerAccent,
            boxShadow: `0 0 12px ${markerAccent}66, inset 0 0 8px ${markerAccent}22`,
          }}
          aria-hidden="true"
        >
          <span>{Math.round(displayScore)}</span>
          <span className="text-slate-300">/100</span>
        </div>
      </div>
      <div className="mt-1 flex items-center justify-between gap-2 text-[10px] font-medium text-slate-300 sm:text-[11px]" aria-hidden="true">
        <span className="text-red-400">Страх</span>
        <span>Нейтрально</span>
        <span className="text-emerald-400">Жадібність</span>
      </div>
    </div>
  );
};
