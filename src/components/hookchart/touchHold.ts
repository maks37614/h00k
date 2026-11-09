export interface TouchHoldPoint { x: number; y: number }

const CONTROL_SELECTOR = 'button, input, select, textarea, a, [role="button"], [contenteditable="true"], .timeJumpDock, .chartScaleDock';

/** Informational chart overlays are part of the plot; actual controls keep their native gestures. */
export function isChartControlTarget(target: EventTarget | null): boolean {
  return !!(target as Element | null)?.closest?.(CONTROL_SELECTOR);
}

interface HoldClock {
  schedule: (callback: () => void, delay: number) => unknown;
  cancel: (handle: unknown) => void;
}

/** One pending hold per chart. A small finger tremor must not turn a hold into a swipe. */
export function createChartTouchHold(clock: HoldClock = {
  schedule: (callback, delay) => setTimeout(callback, delay),
  cancel: handle => clearTimeout(handle as ReturnType<typeof setTimeout>),
}) {
  let candidate: {
    id: number; start: TouchHoldPoint; latest: TouchHoldPoint;
    activate: (point: TouchHoldPoint) => void;
  } | null = null;
  let timer: unknown = null;
  const cancel = () => {
    if (timer !== null) clock.cancel(timer);
    timer = null;
    candidate = null;
  };
  return {
    cancel,
    pending: () => candidate !== null,
    start(id: number, point: TouchHoldPoint, activate: (point: TouchHoldPoint) => void) {
      cancel();
      if (![id, point.x, point.y].every(Number.isFinite)) return;
      const current = { id, start: { ...point }, latest: { ...point }, activate };
      candidate = current;
      timer = clock.schedule(() => {
        if (candidate !== current) return;
        timer = null;
        candidate = null;
        current.activate(current.latest);
      }, 350);
    },
    /** True while waiting: do not edit, pan or scale the chart during the touch slop. */
    move(id: number, point: TouchHoldPoint): boolean {
      if (!candidate || candidate.id !== id) return false;
      if (![point.x, point.y].every(Number.isFinite) ||
          Math.hypot(point.x - candidate.start.x, point.y - candidate.start.y) > 10) {
        cancel();
        return false;
      }
      candidate.latest = { ...point };
      return true;
    },
  };
}
