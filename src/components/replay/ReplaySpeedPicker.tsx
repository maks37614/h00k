import React from 'react';
import { Gauge } from 'lucide-react';

// Keep exactly the same playback rates previously offered in ReplayToolbar.
export const REPLAY_SPEED_OPTIONS = [
  { label: '0.25x', value: 0.25 },
  { label: '0.5x', value: 0.5 },
  { label: '1x', value: 1 },
  { label: '2x', value: 2 },
  { label: '5x', value: 5 },
  { label: '10x', value: 10 },
] as const;

export function ReplaySpeedPicker({ speed, onSpeedChange }: {
  speed: number;
  onSpeedChange: (speed: number) => void;
}) {
  return (
    <label
      className="inline-flex shrink-0 items-center gap-1 rounded-md border border-slate-700 bg-slate-900/90 px-1.5 py-0.5 text-[10px] text-slate-300"
      title="Швидкість відтворення"
    >
      <Gauge className="h-3 w-3 shrink-0 text-cyan-400" aria-hidden="true" />
      <span className="hidden sm:inline whitespace-nowrap">Швидкість</span>
      <select
        aria-label="Швидкість відтворення"
        value={speed}
        onChange={event => onSpeedChange(Number(event.target.value))}
        className="h-6 min-w-[50px] rounded border border-slate-700 bg-slate-950 px-1 font-mono text-[11px] font-bold text-cyan-300 focus:outline-none focus:ring-1 focus:ring-cyan-400"
      >
        {REPLAY_SPEED_OPTIONS.map(option => (
          <option key={option.value} value={option.value}>{option.label}</option>
        ))}
      </select>
    </label>
  );
}
