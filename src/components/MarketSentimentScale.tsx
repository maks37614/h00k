import React, { useEffect, useState } from 'react';

interface MarketSentimentScaleProps {
  score: number;
  sentimentLabel: string;
}

/** Display only the score returned by /api/market/sentiment. */
export const clampSentimentScore = (score: number): number =>
  Number.isFinite(score) ? Math.min(100, Math.max(0, score)) : 0;

/**
 * Compact, accessible fear → greed gauge that stays visible when the detailed
 * market-sentiment panel is collapsed. Its marker transitions when live data
 * changes and starts at neutral before gliding to the first real reading.
 */
export const MarketSentimentScale: React.FC<MarketSentimentScaleProps> = ({ score, sentimentLabel }) => {
  const actualScore = clampSentimentScore(score);
  const [displayScore, setDisplayScore] = useState(50);

  useEffect(() => {
    setDisplayScore(actualScore);
  }, [actualScore]);

  // Prevent the white pointer from spilling outside the rounded ends at 0/100.
  const markerPosition = Math.min(98, Math.max(2, displayScore));

  return (
    <div
      data-market-sentiment-scale
      className="px-3 pb-2.5 pt-2 sm:px-4 sm:pb-3"
      role="meter"
      aria-label="Індекс настрою ринку: від страху до жадібності"
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={actualScore}
      aria-valuetext={`${actualScore} зі 100 — ${sentimentLabel}`}
    >
      <div className="relative py-1.5">
        <div className="h-3 w-full rounded-full bg-[linear-gradient(90deg,#ef4444_0%,#f97316_25%,#eab308_50%,#84cc16_75%,#10b981_100%)] shadow-inner ring-1 ring-white/15" />
        <div
          data-market-sentiment-marker
          className="pointer-events-none absolute top-1/2 -translate-x-1/2 -translate-y-1/2 motion-safe:transition-[left] motion-safe:duration-1000 motion-safe:ease-out"
          style={{ left: `${markerPosition}%` }}
          aria-hidden="true"
        >
          <span className="absolute -inset-1 rounded-full bg-white/20 blur-[3px] motion-safe:animate-[pulse_3s_ease-in-out_infinite]" />
          <span className="relative block h-[19px] w-[5px] rounded-full border border-slate-950 bg-white shadow-[0_0_9px_rgba(255,255,255,0.85)]" />
        </div>
      </div>
      <div className="mt-1 flex items-center justify-between gap-2 text-[10px] font-medium text-slate-400 sm:text-[11px]" aria-hidden="true">
        <span>Страх</span>
        <span>Нейтрально</span>
        <span>Жадібність</span>
      </div>
    </div>
  );
};
