import React, { useEffect, useState } from 'react';
import {
  clampSentimentScore,
  SENTIMENT_SEGMENTS,
  sentimentColorForScore,
} from '../utils/marketSentiment';

interface MarketSentimentScaleProps {
  score: number;
  sentimentLabel: string;
}

export { clampSentimentScore } from '../utils/marketSentiment';

/** Read-only market sentiment meter; the number is always supplied by the API. */
export const MarketSentimentScale: React.FC<MarketSentimentScaleProps> = ({ score, sentimentLabel }) => {
  const actualScore = clampSentimentScore(score);
  // Start at the real score; never briefly paint a misleading 50/100.
  const [displayScore, setDisplayScore] = useState(actualScore);

  useEffect(() => {
    setDisplayScore(actualScore);
  }, [actualScore]);

  const markerPosition = clampSentimentScore(displayScore);
  const markerAccent = sentimentColorForScore(displayScore);
  const activeSegment = SENTIMENT_SEGMENTS.findIndex(s =>
    markerPosition >= s.start && (markerPosition < s.end || s.end === 100),
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
        <div className="flex gap-[4px] sm:gap-[5px]" aria-hidden="true">
          {SENTIMENT_SEGMENTS.map((segment, index) => (
            <span
              key={segment.start}
              data-market-sentiment-segment
              className={`h-[19px] min-w-0 rounded-[5px] shadow-[inset_0_1px_1px_rgba(255,255,255,0.15)] transition-[filter,box-shadow] duration-300 ${index === activeSegment ? 'brightness-110 ring-1 ring-white/40' : ''}`}
              style={{
                backgroundColor: segment.color,
                flexGrow: segment.end - segment.start,
                flexBasis: 0,
              }}
            />
          ))}
        </div>

        {/* The small line always denotes the exact score, even at 0 and 100. */}
        <span
          data-market-sentiment-position
          className="pointer-events-none absolute top-1/2 z-[5] h-7 w-[2px] -translate-x-1/2 -translate-y-1/2 motion-safe:transition-[left,background-color] motion-safe:duration-1000 motion-safe:ease-out"
          style={{ left: `${markerPosition}%`, backgroundColor: markerAccent }}
          aria-hidden="true"
        />
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
