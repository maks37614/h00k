'use strict';

// No gap at the terminal edge: the trading terminal and dock meet pixel-for-pixel.
const DOCK_GAP = 0;
// Separate spacing between multiple h00k panels (not between h00k and the terminal).
const PANEL_GAP = 4;
const MIN_WIDTH = 210;
const MIN_HEIGHT = 140;
function finiteRect(rect) {
  if (!rect || !['x','y','width','height'].every(k => Number.isFinite(rect[k]))) return false;
  return rect.width > 0 && rect.height > 0;
}
function clamp(value, min, max) { return Math.max(min, Math.min(value, max)); }

/**
 * The terminal itself is never resized or covered by dock placement.
 * Return [] when the requested side has insufficient monitor work area.
 * Rectangles use Electron logical display pixels (DIP), not Win32 physical pixels.
 */
function dockRects(target, work, side, width, height, count) {
  if (!finiteRect(target) || !finiteRect(work) || !Number.isInteger(count) || count < 1 || count > 12) return [];
  if (!['right', 'left', 'top', 'bottom'].includes(side)) return [];
  const right = target.x + target.width;
  const bottom = target.y + target.height;
  const workRight = work.x + work.width;
  const workBottom = work.y + work.height;
  const horizontal = side === 'right' || side === 'left';
  const free = side === 'right' ? workRight - right - DOCK_GAP
    : side === 'left' ? target.x - work.x - DOCK_GAP
    : side === 'bottom' ? workBottom - bottom - DOCK_GAP
    : target.y - work.y - DOCK_GAP;
  const thickness = Math.min(horizontal ? width : height, free);
  if (thickness < (horizontal ? MIN_WIDTH : MIN_HEIGHT)) return [];

  const startX = horizontal
    ? side === 'right' ? right + DOCK_GAP : target.x - thickness - DOCK_GAP
    : clamp(target.x, work.x, workRight - Math.min(work.width, target.width));
  const startY = horizontal
    ? clamp(target.y, work.y, workBottom - Math.min(work.height, target.height))
    : side === 'bottom' ? bottom + DOCK_GAP : target.y - thickness - DOCK_GAP;
  const longSize = horizontal ? Math.min(target.height, workBottom - startY)
    : Math.min(target.width, workRight - startX);
  const segment = (longSize - PANEL_GAP * (count - 1)) / count;
  if (segment < (horizontal ? MIN_HEIGHT : MIN_WIDTH)) return [];
  return Array.from({length:count}, (_, index) => ({
    x: Math.round(startX + (horizontal ? 0 : index * (segment + PANEL_GAP))),
    y: Math.round(startY + (horizontal ? index * (segment + PANEL_GAP) : 0)),
    width: Math.round(horizontal ? thickness : segment),
    height: Math.round(horizontal ? segment : thickness),
  }));
}
function floatingRects(target, work, width, height, count, side = 'right') {
  if (!finiteRect(work) || !Number.isInteger(count) || count < 1 || count > 12) return [];
  const w = Math.min(width, work.width);
  const h = Math.min(height, work.height);
  const validTarget = finiteRect(target);
  const baseX = !validTarget
    ? side === 'left' ? work.x + 24
      : side === 'right' ? work.x + work.width - w - 24
      : work.x + Math.round((work.width - w) / 2)
    : side === 'left' ? target.x - w - DOCK_GAP
    : side === 'top' || side === 'bottom' ? target.x + 32
    : target.x + target.width + DOCK_GAP;
  const baseY = !validTarget
    ? side === 'top' ? work.y + 24
      : side === 'bottom' ? work.y + work.height - h - 24
      : work.y + Math.round((work.height - h) / 2)
    : side === 'top' ? target.y - h - DOCK_GAP
    : side === 'bottom' ? target.y + target.height + DOCK_GAP
    : target.y + 32;
  return Array.from({length: count}, (_, index) => ({
    x: Math.round(clamp(baseX + index * 36, work.x, work.x + work.width - w)),
    y: Math.round(clamp(baseY + index * 36, work.y, work.y + work.height - h)),
    width: Math.round(w),
    height: Math.round(h),
  }));
}

const AUTO_SIDES = Object.freeze(['right', 'left', 'top', 'bottom']);
/**
 * Find the largest usable strip directly beside the external terminal.
 * Keep every pane within one monitor's work area and against the terminal
 * edge; never resize or overlap the terminal. Prefer the previous choice
 * when the difference is small to avoid unstable side switching.
 */
function chooseDockPlacement(target, workAreas, width, height, count, previousPlacement = null) {
  if (!finiteRect(target) || !Array.isArray(workAreas)) return null;
  const choices = [];
  for (const [workIndex, work] of workAreas.entries()) {
    if (!finiteRect(work)) continue;
    const wr = work.x + work.width, wb = work.y + work.height;
    const tr = target.x + target.width, tb = target.y + target.height;
    const sharedX = Math.max(0, Math.min(tr, wr) - Math.max(target.x, work.x));
    const sharedY = Math.max(0, Math.min(tb, wb) - Math.max(target.y, work.y));
    for (const side of AUTO_SIDES) {
      const boxes = dockRects(target, work, side, width, height, count);
      if (boxes.length !== count) continue;
      const free = side === 'right' ? wr - tr
        : side === 'left' ? target.x - work.x
        : side === 'bottom' ? wb - tb
        : target.y - work.y;
      const overlap = side === 'right' || side === 'left' ? sharedY : sharedX;
      if (free <= 0 || overlap <= 0) continue;
      const touching = boxes.every(box => {
        const inside = box.x >= work.x && box.y >= work.y
          && box.x + box.width <= wr && box.y + box.height <= wb;
        const adjacent = side === 'right' ? Math.abs(box.x - tr) <= 1
          : side === 'left' ? Math.abs(box.x + box.width - target.x) <= 1
          : side === 'bottom' ? Math.abs(box.y - tb) <= 1
          : Math.abs(box.y + box.height - target.y) <= 1;
        const sharesEdge = (side === 'right' || side === 'left')
          ? Math.min(box.y + box.height, tb) > Math.max(box.y, target.y)
          : Math.min(box.x + box.width, tr) > Math.max(box.x, target.x);
        return inside && adjacent && sharesEdge;
      });
      if (!touching) continue;
      choices.push({side, workIndex, boxes, freeArea:free * overlap});
    }
  }
  if (!choices.length) return null;
  choices.sort((a,b) => b.freeArea - a.freeArea ||
    AUTO_SIDES.indexOf(a.side) - AUTO_SIDES.indexOf(b.side) ||
    a.workIndex - b.workIndex);
  const best = choices[0];
  const familiar = previousPlacement && choices.find(choice =>
    choice.side === previousPlacement.side &&
    choice.workIndex === previousPlacement.workIndex);
  // 15% hysteresis prevents flicker when geometry changes by a few pixels.
  return familiar && familiar.freeArea >= best.freeArea * 0.85 ? familiar : best;
}
module.exports = { dockRects, floatingRects, finiteRect, chooseDockPlacement };
