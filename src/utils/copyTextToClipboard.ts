export async function copyTextToClipboard(text: string): Promise<boolean> {
  if (!text) return false;
  if (typeof navigator !== 'undefined' && navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      // Try the selection-based fallback when clipboard permission is denied.
    }
  }
  if (typeof document === 'undefined' || !document.body) return false;
  const element = document.createElement('textarea');
  element.value = text;
  element.readOnly = true;
  element.style.position = 'fixed';
  element.style.left = '-9999px';
  element.style.top = '0';
  element.setAttribute('aria-hidden', 'true');
  const previousFocus = document.activeElement as HTMLElement | null;
  document.body.appendChild(element);
  try {
    element.focus();
    element.select();
    element.setSelectionRange(0, text.length);
    return document.execCommand('copy');
  } catch {
    return false;
  } finally {
    element.remove();
    previousFocus?.focus?.({ preventScroll: true });
  }
}
