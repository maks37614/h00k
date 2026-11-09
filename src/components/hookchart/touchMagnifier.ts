export interface MagnifierPoint { x: number; y: number }
export interface MagnifierLayout {
  x: number; y: number; radius: number; size: number;
  sourceX: number; sourceY: number; sourceSize: number;
}

export function touchMagnifierLayout(width: number, height: number, point: MagnifierPoint): MagnifierLayout | null {
  if (![width, height, point.x, point.y].every(Number.isFinite) || width < 64 || height < 64) return null;
  const radius = Math.min(58, (width - 12) / 2, (height - 12) / 2);
  const size = radius * 2, sourceSize = size / 2;
  const clamp = (value: number, min: number, max: number) => Math.max(min, Math.min(max, value));
  const selectedX = clamp(point.x, 0, width), selectedY = clamp(point.y, 0, height);
  return {
    // Keep the lens on the crosshair intersection. At chart edges the canvas
    // clips the circle instead of shifting its centre away from the selection.
    x: selectedX,
    y: selectedY,
    radius, size, sourceSize,
    // Keep the selected pixel in the lens centre even at an edge. Clipping the
    // source window itself would move that pixel to (or outside) the round rim.
    sourceX: selectedX - sourceSize / 2,
    sourceY: selectedY - sourceSize / 2,
  };
}

/** Sample the finished chart before painting the lens, so it cannot magnify itself. */
export function drawTouchMagnifier(
  chart: HTMLCanvasElement, context: CanvasRenderingContext2D,
  sample: HTMLCanvasElement, width: number, height: number, point: MagnifierPoint,
  backgroundColor = '#131722',
  paintSourceOverlay?: (context: CanvasRenderingContext2D) => void,
): void {
  const layout = touchMagnifierLayout(width, height, point);
  if (!layout) return;
  const { x, y, radius, size, sourceX, sourceY, sourceSize } = layout;
  const scaleX = chart.width / width, scaleY = chart.height / height;
  // A 2x lens does not need a 3x/4x scratch bitmap on high-DPI phones.
  const sampleWidth = Math.max(1, Math.ceil(size * Math.min(2, scaleX)));
  const sampleHeight = Math.max(1, Math.ceil(size * Math.min(2, scaleY)));
  if (sample.width !== sampleWidth) sample.width = sampleWidth;
  if (sample.height !== sampleHeight) sample.height = sampleHeight;
  const buffer = sample.getContext('2d');
  if (!buffer) return;
  buffer.clearRect(0, 0, sampleWidth, sampleHeight);
  buffer.imageSmoothingEnabled = false;
  const left = Math.max(0, sourceX), top = Math.max(0, sourceY);
  const right = Math.min(width, sourceX + sourceSize), bottom = Math.min(height, sourceY + sourceSize);
  // Copy only legal source pixels and preserve their offset in the padded sample.
  // This avoids browser-dependent clipping of negative drawImage source rectangles.
  buffer.drawImage(chart,
    left * scaleX, top * scaleY, (right - left) * scaleX, (bottom - top) * scaleY,
    (left - sourceX) / sourceSize * sampleWidth, (top - sourceY) / sourceSize * sampleHeight,
    (right - left) / sourceSize * sampleWidth, (bottom - top) / sourceSize * sampleHeight);

  if (paintSourceOverlay) {
    buffer.save();
    buffer.setTransform(sampleWidth / sourceSize, 0, 0, sampleHeight / sourceSize,
      -sourceX / sourceSize * sampleWidth, -sourceY / sourceSize * sampleHeight);
    paintSourceOverlay(buffer);
    buffer.restore();
  }

  context.save();
  context.globalAlpha = 1;
  context.setLineDash([]);
  context.shadowColor = 'rgba(0,0,0,.55)';
  context.shadowBlur = 14;
  context.fillStyle = backgroundColor;
  context.beginPath();
  context.arc(x, y, radius, 0, Math.PI * 2);
  context.fill();
  context.shadowBlur = 0;
  context.clip();
  context.imageSmoothingEnabled = false;
  context.drawImage(sample, x - radius, y - radius, size, size);
  context.restore();
  context.save();
  context.globalAlpha = 1;
  context.setLineDash([]);
  context.strokeStyle = '#aab5c4';
  context.lineWidth = 1.5;
  context.beginPath();
  context.arc(x, y, radius, 0, Math.PI * 2);
  context.stroke();
  context.restore();
}
