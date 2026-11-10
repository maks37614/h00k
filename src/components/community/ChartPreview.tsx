import React from "react";
import {
  chartCandles,
  type ChartDocument,
} from "../../community/chartDocument";

/** Small SVG preview: mounting a feed card never mounts a chart/feed or requests history. */
export function ChartPreview({
  document,
  onOpen,
}: {
  document: ChartDocument;
  onOpen: () => void;
}) {
  const rows = (chartCandles(document, document.timeframe) ?? []).slice(-70);
  if (!rows.length) return null;
  const min = Math.min(
    ...rows.map((k) => k.low),
    ...document.markers.map((m) => m.price),
  );
  const max = Math.max(
    ...rows.map((k) => k.high),
    ...document.markers.map((m) => m.price),
  );
  const y = (price: number) => 155 - ((price - min) / (max - min || 1)) * 140;
  const step = 600 / rows.length;
  return (
    <button
      type="button"
      className="community-chart-preview"
      onClick={onOpen}
      aria-label={`Відкрити HookChart ${document.symbol}`}
    >
      <svg
        viewBox="0 0 600 170"
        role="img"
        aria-label={`${document.symbol}, ${document.timeframe}, знімок без live-потоку`}
      >
        {rows.map((k, i) => (
          <g
            key={k.time}
            stroke={k.close >= k.open ? "#34d399" : "#fb7185"}
            fill={k.close >= k.open ? "#34d399" : "#fb7185"}
          >
            <line
              x1={(i + 0.5) * step}
              x2={(i + 0.5) * step}
              y1={y(k.high)}
              y2={y(k.low)}
            />
            <rect
              x={(i + 0.2) * step}
              width={Math.max(1, step * 0.6)}
              y={Math.min(y(k.open), y(k.close))}
              height={Math.max(1, Math.abs(y(k.open) - y(k.close)))}
            />
          </g>
        ))}
        {document.markers.map((m) => (
          <line
            key={m.id}
            x1="0"
            x2="600"
            y1={y(m.price)}
            y2={y(m.price)}
            stroke={m.color}
            strokeDasharray="4 4"
          />
        ))}
      </svg>
      <span>
        {document.symbol} · {document.timeframe} · Відкрити та відповісти
        розміткою ↗
      </span>
    </button>
  );
}
