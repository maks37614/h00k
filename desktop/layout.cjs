'use strict';

const GAP = 6;
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
  const free = side === 'right' ? workRight - right - GAP
    : side === 'left' ? target.x - work.x - GAP
    : side === 'bottom' ? workBottom - bottom - GAP
    : target.y - work.y - GAP;
  const thickness = Math.min(horizontal ? width : height, free);
  if (thickness < (horizontal ? MIN_WIDTH : MIN_HEIGHT)) return [];

  const startX = horizontal
    ? side === 'right' ? right + GAP : target.x - thickness - GAP
    : clamp(target.x, work.x, workRight - Math.min(work.width, target.width));
  const startY = horizontal
    ? clamp(target.y, work.y, workBottom - Math.min(work.height, target.height))
    : side === 'bottom' ? bottom + GAP : target.y - thickness - GAP;
  const longSize = horizontal ? Math.min(target.height, workBottom - startY)
    : Math.min(target.width, workRight - startX);
  const segment = (longSize - GAP * (count - 1)) / count;
  if (segment < (horizontal ? MIN_HEIGHT : MIN_WIDTH)) return [];
  return Array.from({length:count}, (_, index) => ({
    x: Math.round(startX + (horizontal ? 0 : index * (segment + GAP))),
    y: Math.round(startY + (horizontal ? index * (segment + GAP) : 0)),
    width: Math.round(horizontal ? thickness : segment),
    height: Math.round(horizontal ? segment : thickness),
  }));
}
function floatingRects(target, work, width, height, count, side = 'right') {
  if (!finiteRect(work) || !Number.isInteger(count) || count < 1 || count > 12) return [];
  const w = Math.min(width, work.width);
  const h = Math.min(height, work.height);
  const validTarget = finiteRect(target);
  const baseX = !validTarget ? work.x + 32
    : side === 'left' ? target.x - w - GAP
    : side === 'top' || side === 'bottom' ? target.x + 32
    : target.x + target.width + GAP;
  const baseY = !validTarget ? work.y + 32
    : side === 'top' ? target.y - h - GAP
    : side === 'bottom' ? target.y + target.height + GAP
    : target.y + 32;
  return Array.from({length: count}, (_, index) => ({
    x: Math.round(clamp(baseX + index * 36, work.x, work.x + work.width - w)),
    y: Math.round(clamp(baseY + index * 36, work.y, work.y + work.height - h)),
    width: Math.round(w),
    height: Math.round(h),
  }));
}
module.exports = { dockRects, floatingRects };
