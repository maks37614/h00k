/**
 * A visual, inert copy of the page that opened a routed HookChart.
 *
 * This is deliberately NOT a React root or a mounted Screener. cloneNode()
 * does not copy React handlers/effects, WebSocket streams, subscriptions or
 * timers. The real Screener still unmounts when the chart route is active.
 *
 * Keep this snapshot in memory only. Never persist account data or a DOM
 * snapshot to session/local storage, and never clone interactive overlays.
 */
const MAX_FROZEN_ELEMENTS = 9000;

function frozenPart(source: HTMLElement, viewportWidth: number, viewportHeight: number): HTMLElement | null {
  const rect = source.getBoundingClientRect();
  if (rect.bottom <= 0 || rect.top >= viewportHeight || rect.right <= 0 || rect.left >= viewportWidth) return null;

  const clone = source.cloneNode(true) as HTMLElement;
  // Prevent any nested embedded page, media playback, scripted content or
  // independent drawing from starting behind the live HookChart.
  clone.querySelectorAll('script, iframe, video, audio, object, embed, source, canvas, animate, animateMotion, animateTransform')
    .forEach(element => element.remove());
  // Passwords and other text entered by the user must not become part of
  // an on-screen clone (even though the clone is inert).
  clone.querySelectorAll('input, textarea, select, [contenteditable]')
    .forEach(element => {
      if (element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement) {
        element.value = '';
        element.removeAttribute('value');
        element.removeAttribute('placeholder');
      }
      if (element instanceof HTMLElement) element.removeAttribute('contenteditable');
    });
  // Browser images that have not finished loading must not start an extra
  // request merely because we opened a chart.
  const originals = source.querySelectorAll('img');
  const copied = clone.querySelectorAll('img');
  for (let i = 0; i < copied.length; i++) {
    const image = copied[i];
    if (!originals[i]?.complete || originals[i]?.naturalWidth === 0) {
      image.removeAttribute('src');
      image.removeAttribute('srcset');
    }
    image.loading = 'lazy';
    image.decoding = 'async';
  }
  clone.querySelectorAll('[id]').forEach(element => element.removeAttribute('id'));
  clone.setAttribute('aria-hidden', 'true');
  clone.inert = true;
  clone.style.position = 'absolute';
  clone.style.left = `${rect.left}px`;
  clone.style.top = `${rect.top}px`;
  clone.style.width = `${rect.width}px`;
  clone.style.minHeight = `${Math.max(0, rect.height)}px`;
  clone.style.margin = '0';
  clone.style.pointerEvents = 'none';
  return clone;
}

export function captureChartPageBackdrop(root: HTMLElement | null): HTMLDivElement | null {
  if (!root || typeof window === 'undefined') return null;
  const main = Array.from(root.children).find((child): child is HTMLElement => child.tagName === 'MAIN');
  if (!main) return null;

  // Protect the chart from very large Terminal/Screener tables. A soft
  // gradient is preferable to duplicating tens of thousands of DOM nodes.
  const sources = Array.from(root.children)
    .filter((child): child is HTMLElement => child instanceof HTMLElement
      && ['HEADER', 'MAIN', 'FOOTER'].includes(child.tagName));
  const count = sources.reduce((total, source) => total + source.getElementsByTagName('*').length, 0);
  if (count > MAX_FROZEN_ELEMENTS) return null;

  const frame = root.ownerDocument.createElement('div');
  frame.className = 'chart-page-backdrop__frozen text-slate-100';
  frame.setAttribute('aria-hidden', 'true');
  frame.inert = true;
  const viewportWidth = window.innerWidth;
  const viewportHeight = window.innerHeight;
  for (const source of sources) {
    const part = frozenPart(source, viewportWidth, viewportHeight);
    if (part) frame.appendChild(part);
  }
  return frame.hasChildNodes() ? frame : null;
}
