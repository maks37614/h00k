import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  getUserSiteNotificationSettings, isUserTelegramCategoryAllowed, categoryForServerEvent,
} from '../server/siteNotificationPrefs';
import { normalizeSiteNotificationSettings, notificationEnabled } from '../src/utils/siteNotifications';

test('background Telegram fails closed for guests and unconfigured profiles', () => {
  assert.equal(getUserSiteNotificationSettings('guest').enabled, false);
  const source = { source: 'PRICE_ALERT', eventType: 'PRICE_ALERT', symbol: 'BTCUSDT',
    exchange: 'binance', marketType: 'futures' };
  assert.equal(isUserTelegramCategoryAllowed('guest', source), false);
  assert.equal(isUserTelegramCategoryAllowed('user-without-preferences', source), false);
  assert.equal(notificationEnabled(normalizeSiteNotificationSettings({
    optedIn: true, enabled: true, price: true, telegramEnabled: false,
  }), 'price'), true, 'site notification may be on while Telegram remains separately off');
});

test('server category routing uses event taxonomy rather than guessing by coin', () => {
  assert.equal(categoryForServerEvent('PRICE_ALERT', 'PRICE_ALERT'), 'price');
  assert.equal(categoryForServerEvent('FORMATION_DETECTED', 'SCREENER'), 'formation');
  assert.equal(categoryForServerEvent('DENSITY_APPEARED', 'SURVEILLANCE'), 'density');
  assert.equal(categoryForServerEvent('OI_ANOMALY', 'SURVEILLANCE'), 'openInterest');
  assert.equal(categoryForServerEvent('LEVEL_CROSS_15M', 'SURVEILLANCE'), 'breakouts');
  assert.equal(categoryForServerEvent('CHANNEL_BREAKOUT', 'SURVEILLANCE'), 'breakouts');
  assert.equal(categoryForServerEvent('FIBONACCI', 'SURVEILLANCE'), 'levels');
  assert.equal(categoryForServerEvent('MOMENTUM', 'SURVEILLANCE'), 'impulse');
});

test('preferences endpoint is authenticated, and all automatic Telegram send paths are gated', () => {
  const server = readFileSync(new URL('../server.ts', import.meta.url), 'utf8');
  const router = readFileSync(new URL('../server/notificationRouter.ts', import.meta.url), 'utf8');
  const price = readFileSync(new URL('../server/alertService.ts', import.meta.url), 'utf8');
  const context = readFileSync(new URL('../src/context/SiteNotificationsContext.tsx', import.meta.url), 'utf8');
  assert.match(server, /'\/api\/notification-preferences'\], requireUserAuth/);
  assert.match(server, /app\.put\('\/api\/notification-preferences'/);
  assert.match(router, /isUserTelegramCategoryAllowed\(params\.userId/);
  assert.match(price, /if \(!userAllowedTelegram\)/);
  assert.match(context, /apiFetch\('\/api\/notification-preferences'/);
});
