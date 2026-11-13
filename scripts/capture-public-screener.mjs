/** Capture real production h00k.top UI for the public marketing gallery.
 * Requires: npm install --no-save playwright && npx playwright install chromium
 * Captures public content only, never bypasses authentication.
 */
import { chromium } from 'playwright';
import { mkdir } from 'node:fs/promises';

const out = 'public/guest-shots';
await mkdir(out, { recursive: true });
const browser = await chromium.launch({ headless: true });
async function openScreener(viewport) {
  const page = await browser.newPage({ viewport, deviceScaleFactor: 1, colorScheme: 'dark' });
  await page.goto('https://h00k.top/#screener', { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForFunction(() => document.body?.innerText?.includes('BTC/USDT'), null, { timeout: 60000 });
  await page.waitForTimeout(5000);
  const text = await page.locator('body').innerText();
  if (!text.includes('Знайдено:') || !text.includes('BTC/USDT')) {
    throw new Error('Live Screener is not visible; refusing to save a misleading screenshot');
  }
  return page;
}
try {
  const desktop = await openScreener({ width: 1440, height: 920 });
  await desktop.screenshot({ path: `${out}/screener-overview.png`, animations: 'disabled' });
  await desktop.evaluate(() => {
    const labels = [...document.querySelectorAll('*')];
    const found = labels.find(el => el.children.length === 0 && el.textContent?.trim().startsWith('Знайдено:'));
    if (found) {
      found.scrollIntoView({ block: 'start' });
      window.scrollBy(0, -210);
    } else {
      const column = labels.find(el => el.children.length === 0 && el.textContent?.trim() === 'Монета');
      if (column) { column.scrollIntoView({ block: 'start' }); window.scrollBy(0, -240); }
    }
  });
  await desktop.waitForTimeout(1800);
  await desktop.screenshot({ path: `${out}/screener-table.png`, animations: 'disabled' });
  await desktop.close();

  const mobile = await openScreener({ width: 390, height: 844 });
  await mobile.screenshot({ path: `${out}/screener-mobile.png`, animations: 'disabled' });
  await mobile.close();
  console.log('Captured three genuine guest screenshots from https://h00k.top/#screener');
} finally {
  await browser.close();
}
