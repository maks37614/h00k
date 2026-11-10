import React, { useMemo, useRef, useState } from "react";
import type { ChartMarkerInfo, Kline, Timeframe } from "../../types";
import {
  chartCandles,
  COMMUNITY_TIMEFRAMES,
  type ChartDocument,
} from "../../community/chartDocument";
import {
  Chart,
  ChartTimeAxis,
  calcCascadeRisk,
  type Viewport,
  type HookChartHandle,
} from "../hookchart/engine";
import { createChartCrosshairStore } from "../hookchart/crosshairState";
import { toHookCandles } from "../../utils/hookchartData";
import "../hookchart/hookchart.css";
import "../hookchart/integration.css";
import "./community.css";

interface Props {
  value: ChartDocument;
  onChange: (next: ChartDocument) => void;
  onHistory?: (timeframe: Timeframe, before: number) => Promise<Kline[]>;
}
const tools = [
  ["cursor", "Курсор"],
  ["level", "Рівень"],
  ["trend", "Тренд"],
  ["ray", "Промінь"],
  ["rect", "Зона"],
  ["fib", "Фібоначчі"],
  ["profile", "Обсяг"],
  ["text", "Текст"],
  ["ruler", "Вимірювання"],
  ["erase", "Гумка"],
];
const emptyRisk = calcCascadeRisk([], Number.MAX_VALUE, 0, 0);

/** Uses only HookChart's drawing engine. No feed hooks, settings, profile writes or direct-exchange fallback. */
export default function SharedHookChart({ value, onChange, onHistory }: Props) {
  const [tool, setTool] = useState("cursor");
  const [note, setNote] = useState("Нотатка");
  const [status, setStatus] = useState("");
  const [busy, setBusy] = useState(false);
  const [viewport, setViewport] = useState<Viewport>({
    barWidth: 8,
    rightOffset: 0,
    autoY: true,
    manualCenter: null,
    manualRange: null,
  });
  const [undo, setUndo] = useState<ChartDocument[]>([]);
  const latest = useRef(value);
  latest.current = value;
  const initial = useRef(value);
  const scope = `${value.exchange}:${value.marketType}:${value.symbol}:${value.capturedAt}`;
  const owner = useRef(scope);
  owner.current = scope;
  const handle = useRef<HookChartHandle>(null);
  const crosshair = useMemo(
    () => createChartCrosshairStore(),
    [scope, value.timeframe],
  );
  const rows = useMemo(
    () => chartCandles(value, value.timeframe) ?? [],
    [value],
  );
  const candles = useMemo(() => toHookCandles(rows), [rows]);
  const commit = (patch: Partial<ChartDocument>) => {
    const current = latest.current;
    setUndo((items) => [...items.slice(-29), current]);
    const next = { ...current, ...patch };
    if (patch.series) {
      let remaining = 4000;
      const bounded: ChartDocument["series"] = {};
      for (const tf of [
        next.timeframe,
        ...COMMUNITY_TIMEFRAMES.filter((tf) => tf !== next.timeframe),
      ]) {
        const rows = next.series[tf];
        if (rows?.length && remaining) {
          bounded[tf] = rows.slice(-Math.min(rows.length, remaining));
          remaining -= bounded[tf]!.length;
        }
      }
      next.series = bounded;
    }
    latest.current = next;
    onChange(next);
  };
  const load = async (tf: Timeframe, before: number, switchTo = false) => {
    if (!onHistory || busy) return false;
    const started = owner.current;
    setBusy(true);
    setStatus("");
    try {
      const incoming = await onHistory(
        tf,
        Math.min(before, latest.current.cutoff),
      );
      if (owner.current !== started) return false;
      if (!incoming.length) {
        setStatus("Історії в цій ділянці немає");
        return false;
      }
      const current = latest.current;
      // Preserve the frozen captured candles where a historical response overlaps.
      const merged = new Map(
        incoming
          .filter((k) => k.time <= current.cutoff)
          .map((k) => [k.time, k]),
      );
      for (const k of current.series[tf] ?? []) merged.set(k.time, k);
      const sorted = [...merged.values()].sort((a, b) => a.time - b.time);
      const backwards = before < (current.series[tf]?.[0]?.time ?? before);
      const next = backwards ? sorted.slice(0, 2000) : sorted.slice(-2000);
      commit({
        series: { ...current.series, [tf]: next },
        ...(switchTo ? { timeframe: tf, viewport: undefined } : {}),
      });
      return true;
    } catch (error) {
      setStatus(
        error instanceof Error ? error.message : "Не вдалося отримати історію",
      );
      return false;
    } finally {
      if (owner.current === started) setBusy(false);
    }
  };
  const selectTimeframe = async (tf: Timeframe) => {
    const derived = chartCandles(latest.current, tf);
    if (derived?.length) {
      commit({
        timeframe: tf,
        viewport: undefined,
        series: { ...latest.current.series, [tf]: derived },
      });
      return;
    }
    if (!onHistory) {
      setStatus("Цього таймфрейму немає у знімку");
      return;
    }
    await load(tf, value.cutoff, true);
  };
  const changeMarker = (id: string, patch: Partial<ChartMarkerInfo>) =>
    commit({
      markers: latest.current.markers.map((m) =>
        m.id === id ? { ...m, ...patch } : m,
      ),
    });
  return (
    <div className="community-chart-editor">
      <div className="community-chart-heading">
        <b>
          {value.symbol} · {value.exchange.toUpperCase()} · {value.marketType}
        </b>
        <span>
          Авторський знімок ·{" "}
          {new Date(value.capturedAt).toLocaleString("uk-UA")}
        </span>
      </div>
      <div
        className="community-toolbar"
        role="toolbar"
        aria-label="Таймфрейми та інструменти графіка"
      >
        {COMMUNITY_TIMEFRAMES.map((tf) => (
          <button
            type="button"
            key={tf}
            aria-pressed={tf === value.timeframe}
            disabled={busy}
            onClick={() => void selectTimeframe(tf)}
          >
            {tf}
          </button>
        ))}
        <button
          type="button"
          disabled={busy || !onHistory}
          onClick={() =>
            void load(value.timeframe, (rows[0]?.time ?? value.cutoff) - 1)
          }
        >
          Історія ←
        </button>
        <button type="button" onClick={() => handle.current?.fitContent()}>
          Уся історія
        </button>
        <button
          type="button"
          onClick={() =>
            commit({
              timeframe: initial.current.timeframe,
              series: initial.current.series,
            })
          }
        >
          До знімка
        </button>
        <button
          type="button"
          disabled={!undo.length}
          onClick={() => {
            const previous = undo.at(-1);
            if (previous) {
              setUndo(undo.slice(0, -1));
              latest.current = previous;
              onChange(previous);
            }
          }}
        >
          Скасувати
        </button>
      </div>
      <div
        className="community-toolbar"
        role="toolbar"
        aria-label="Панель малювання"
      >
        {tools.map(([id, label]) => (
          <button
            type="button"
            key={id}
            aria-pressed={tool === id}
            onClick={() => setTool(id)}
          >
            {label}
          </button>
        ))}
        {tool === "text" && (
          <input
            aria-label="Текст позначки"
            value={note}
            maxLength={500}
            onChange={(e) => setNote(e.target.value)}
          />
        )}
      </div>
      <div
        className="hookchart-root community-hookchart"
        data-chart-provider="hookchart"
        data-network-mode="snapshot"
      >
        <Chart
          key={`${scope}:${value.timeframe}`}
          candles={candles}
          symbol={value.symbol}
          tf={value.timeframe}
          initialLogicalRange={value.viewport}
          tool={tool}
          drawings={value.drawings}
          setDrawings={(update) =>
            commit({
              drawings:
                typeof update === "function"
                  ? update(latest.current.drawings)
                  : update,
            })
          }
          markers={value.markers}
          onMarkersChange={(markers) => commit({ markers })}
          alerts={[]}
          setAlerts={() => {}}
          densities={[]}
          marketPrints={[]}
          liquidations={[]}
          autoLevels={[]}
          cascadeRisk={emptyRisk}
          levelLabelMode="always"
          showLiquidations={false}
          showLiqRiskBlock={false}
          showDensityLines={false}
          rightPaddingBars={14}
          expandPriceScaleToMarkers
          hideBarCountdown
          timezone="UTC"
          textLabel={note}
          onViewportChange={setViewport}
          onCrosshairChange={crosshair.set}
          controlRef={handle}
          onNeedHistory={(target) =>
            load(
              value.timeframe,
              Math.min(
                Math.floor(target / 1000),
                (rows[0]?.time ?? value.cutoff) - 1,
              ),
            )
          }
        />
        <ChartTimeAxis
          candles={candles}
          tf={value.timeframe}
          timezone="UTC"
          viewport={viewport}
          rightPaddingBars={14}
          crosshair={crosshair}
        />
      </div>
      <p className="community-hint">
        Перетягуйте мітки за лінії, малюнки — за точки або лінії. Зміни
        стосуються лише вашої відповіді. Біржові потоки не підключаються.
      </p>
      <details>
        <summary>Усі мітки та малюнки</summary>
        <div className="community-marker-list">
          {value.markers.map((marker) => (
            <div key={marker.id}>
              <input
                aria-label="Назва мітки"
                value={marker.label}
                maxLength={160}
                onChange={(e) =>
                  changeMarker(marker.id, { label: e.target.value })
                }
              />
              <input
                aria-label={`Ціна ${marker.label}`}
                type="number"
                step="any"
                value={marker.price}
                onChange={(e) => {
                  const price = Number(e.target.value);
                  if (price > 0) changeMarker(marker.id, { price });
                }}
              />
              <input
                aria-label="Колір мітки"
                type="color"
                value={marker.color}
                onChange={(e) =>
                  changeMarker(marker.id, { color: e.target.value })
                }
              />
              <button
                type="button"
                onClick={() =>
                  commit({
                    markers: value.markers.filter((m) => m.id !== marker.id),
                  })
                }
              >
                Видалити
              </button>
            </div>
          ))}
        </div>
        <button
          type="button"
          onClick={() =>
            commit({
              markers: [
                ...value.markers,
                {
                  id: crypto.randomUUID(),
                  type: "custom",
                  label: "Мій рівень",
                  price: rows.at(-1)?.close ?? 1,
                  color: "#38bdf8",
                },
              ],
            })
          }
        >
          Додати мітку
        </button>
        {value.drawings.map((drawing) => (
          <div className="community-drawing-row" key={drawing.id}>
            <span>{drawing.type}</span>
            <input
              aria-label="Текст малюнка"
              value={drawing.text ?? ""}
              onChange={(e) =>
                commit({
                  drawings: value.drawings.map((d) =>
                    d.id === drawing.id ? { ...d, text: e.target.value } : d,
                  ),
                })
              }
            />
            {drawing.pts.map((point, i) => (
              <input
                key={i}
                type="number"
                step="any"
                aria-label={`Ціна точки ${i + 1}`}
                value={point.p}
                onChange={(e) => {
                  const p = Number(e.target.value);
                  if (p >= 0)
                    commit({
                      drawings: value.drawings.map((d) =>
                        d.id === drawing.id
                          ? {
                              ...d,
                              pts: d.pts.map((old, at) =>
                                at === i ? { ...old, p } : old,
                              ),
                            }
                          : d,
                      ),
                    });
                }}
              />
            ))}
            <button
              type="button"
              onClick={() =>
                commit({
                  drawings: value.drawings.filter((d) => d.id !== drawing.id),
                })
              }
            >
              Видалити
            </button>
          </div>
        ))}
      </details>
      {(busy || status) && (
        <p role="status">{busy ? "Завантаження спільної історії…" : status}</p>
      )}
    </div>
  );
}
