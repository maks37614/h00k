import express from 'express';
import path from 'path';
import { installProductionAssets } from './server/productionAssets';
import { createServer as createViteServer } from 'vite';
import { runScreenerScan, fetchKlines, fetchDualExchangeOI } from './server/marketService';
import { installMarketQuoteRoutes, publicQuoteResponseCache } from './server/marketQuoteResponse';
import { installFullEarlyScanRoutes } from './server/earlyScanRoutes';
import { fetch24hTradeCount } from './server/chartMarketStats';
import { analyzeFormationWithAI } from './server/geminiService';
import { generateSmartAnalysis } from './server/smartAnalysisService';
import { calculateMarketSentiment } from './server/sentimentService';
import { installTelegramRoutes } from './server/telegramRoutes';
import { startSharedTelegramBot } from './server/telegramLinkService';
import {
  getAllAlerts,
  checkAlertsOnce,
  createAlert,
  createAlertsBatch,
  deleteAlert,
  toggleAlert,
  clearTriggeredAlerts,
  syncUserAlerts,
  getAlertHistory,
  clearAlertHistory,
  deleteHistoryItem,
  getUserTelegram,
  createSetupAlertsGroup,
} from './server/alertService';
import {
  loadSurveillanceList,
  saveSurveillanceList,
  getDefaultSurveillanceConfig,
  checkCoinSurveillance,
  checkAllUserCoins,
  findSurveillanceCoinById,
  setAllSurveillanceCoinsActive,
  commitSurveillanceCheck,
  validateSurveillanceConfig,
} from './server/surveillanceService';
import { ExchangeId, MarketType, Timeframe } from './src/types';
import { normalizeLanguage, telegramText } from './src/locales';
import { normalizeExchangeSymbol } from './src/utils/marketSymbols';
import { cronManager } from './server/cronService';
import { surveillanceManager } from './server/surveillance/surveillanceManager';
import { surveillanceReplayEngine } from './server/surveillance/replayEngine';
import { fetchHookChartOIHistory } from './server/hookchartOI';
import { requireUserAuth } from './server/userAuth';
import { sendUserTelegramMessage, startTelegramDeliveryWorker } from './server/telegramDelivery';
import { installPaperFeed } from './server/paperFeed';
import { installMonMarketFeed } from './server/monMarketFeed';
import { formationDensityFeed } from './server/formationDensityFeed';
import { installHookChartDepthStream } from './server/hookChartDepth';
import { installLiquidationStream } from './server/liquidationFeed';
import { installOpsMetrics } from './server/opsMetrics';
import { binanceTickerStream } from './server/binanceTickerStream';

async function startServer() {
  const app = express();
  const PORT = process.env.PORT ? parseInt(process.env.PORT, 10) : 3000;

  app.use(express.json());

  // Read-only operator endpoint is disabled unless H00K_OPS_TOKEN is configured.
  let chartDepthMetrics: (() => { activeMarkets: number; clients: number }) | null = null;
  installOpsMetrics(app, () => chartDepthMetrics?.() ?? null);

  // Dedicated read-only Bearer credential for the PHP bot on external hosting.
  installPaperFeed(app);
  // Krystian reads verified cached formations and bounded live depth.
  // Register API routes BEFORE the SPA HTML fallback.
  installMonMarketFeed(app);

  app.use(['/api/alerts', '/api/telegram', '/api/surveillance', '/api/cron'], requireUserAuth);

  // Health check
  app.get('/api/health', (req, res) => {
    res.json({ status: 'ok', timestamp: Date.now() });
  });

  // Unified Cron Status & Diagnostics
  app.get('/api/cron/status', (req, res) => {
    try {
      const status = cronManager.getStatus(res.locals.userId);
      res.json({ success: true, ...status });
    } catch (err: any) {
      res.status(500).json({ success: false, error: err?.message || 'Failed to get cron status' });
    }
  });

  // Manual Trigger for Cron Jobs (e.g. from external cron services or user test button)
  app.post('/api/cron/run', async (req, res) => {
    try {
      const jobId = (req.body?.job || 'all').toString();
      if (!['all', 'price_alerts', 'surveillance'].includes(jobId)) return res.status(400).json({ success: false, error: 'Невідоме завдання' });
      if (jobId !== 'surveillance') await checkAlertsOnce(res.locals.userId);
      if (jobId !== 'price_alerts') await checkAllUserCoins(res.locals.userId);
      const result = { success: true, message: 'Ваші сповіщення перевірено' };
      res.json(result);
    } catch (err: any) {
      res.status(500).json({ success: false, error: err?.message || 'Failed to trigger cron job' });
    }
  });

  // Test notification dispatch pipeline (Telegram + in-app)
  app.post('/api/cron/test-alert', async (req, res) => {
    try {
      const { userId, symbol, note, language } = req.body;
      const testSymbol = (symbol || 'BTCUSDT').toUpperCase();
      const userTg = getUserTelegram(userId);
      const selectedLanguage = normalizeLanguage(language || userTg?.language);
      const effectiveToken = userTg?.botToken;
      const effectiveChat = userTg?.chatId;

      if (!effectiveToken || !effectiveChat) {
        return res.status(400).json({
          success: false,
          error: 'Спочатку підключіть свій Telegram у профілі або налаштуваннях сповіщень.',
        });
      }

      const localeTag = selectedLanguage === 'en' ? 'en-US' : selectedLanguage === 'ru' ? 'ru-RU' : selectedLanguage === 'pl' ? 'pl-PL' : 'uk-UA';
      const timeStr = new Date().toLocaleTimeString(localeTag, { timeZone: 'Europe/Kyiv' });
      const noteLine = note ? telegramText(selectedLanguage, 'noteLine', { note: String(note) }) : '';
      const testMsg = telegramText(selectedLanguage, 'cronTest', {
        symbol: testSymbol,
        noteLine,
        time: timeStr,
      });

      const tgResult = await sendUserTelegramMessage(userId, testMsg);

      res.json({
        success: tgResult.success,
        telegramSent: tgResult.success,
        error: tgResult.error,
        message: tgResult.success
          ? 'Тестове сповіщення успішно надіслано у ваш Telegram!'
          : `Помилка доставки в Telegram: ${tgResult.error}`,
      });
    } catch (err: any) {
      res.status(500).json({ success: false, error: err?.message || 'Помилка надсилання тесту' });
    }
  });

  // Keep registration codes on the server so they are not shipped in the browser bundle.
  const AUTHOR_VALID_CODES = new Set(
    (process.env.ACCESS_CODES || '')
      .split(',')
      .map((code) => code.trim().toUpperCase())
      .filter(Boolean),
  );

  app.post('/api/auth/verify-code', (req, res) => {
    const code = (req.body?.code || '').toString().trim().toUpperCase();
    if (!code) {
      return res.status(400).json({ valid: false, message: 'Код не вказано' });
    }
    const isValid = AUTHOR_VALID_CODES.has(code);
    return res.json({
      valid: isValid,
      code,
      message: isValid
        ? 'Спеціальний код підтверджено'
        : 'Недійсний код доступу. Отримайте дійсний код у Telegram каналі автора.',
    });
  });

  // Dedicated full-universe early W/M scan: progressive, throttled and shared across clients.
  installFullEarlyScanRoutes(app);

  // Screener Scan endpoint
  app.get('/api/screener/scan', async (req, res) => {
    try {
      const exchange = (req.query.exchange as 'all' | ExchangeId) || 'all';
      const marketType = (req.query.marketType as 'all' | MarketType) || 'all';
      const timeframe = (req.query.timeframe as Timeframe) || '1h';
      const minVolumeUsd = req.query.minVolume !== undefined ? parseFloat(req.query.minVolume as string) : 50_000;

      const results = await runScreenerScan({
        exchange,
        marketType,
        timeframe,
        minVolumeUsd,
      });

      res.json({
        success: true,
        count: results.length,
        coinsWithFormationsCount: results.filter((c) => c.formations.length > 0).length,
        data: results,
      });
    } catch (err: any) {
      console.error('Error during screener scan:', err);
      res.status(500).json({ success: false, error: err.message || 'Scan failed' });
    }
  });

  // Reuse identical public snapshots across many browser requests.
  // The endpoint schema and query validation remain unchanged.
  installMarketQuoteRoutes(app, publicQuoteResponseCache);

  // Market Sentiment endpoint ("Настрій Ринку")
  app.get('/api/market/sentiment', async (req, res) => {
    try {
      const sentiment = await calculateMarketSentiment();
      res.json({ success: true, data: sentiment });
    } catch (err: any) {
      console.error('Error calculating market sentiment:', err);
      res.status(500).json({ success: false, error: err.message || 'Failed to calculate market sentiment' });
    }
  });

  // Smart Analysis endpoint ("Розумний Аналіз")
  app.get('/api/market/smart-analysis', async (req, res) => {
    try {
      const symbol = (req.query.symbol as string) || 'BTCUSDT';
      const exchange = (req.query.exchange as ExchangeId) || 'binance';
      const marketType = (req.query.marketType as MarketType) || 'futures';
      const timeframe = (req.query.timeframe as Timeframe) || '1h';
      const currentPrice = req.query.price ? parseFloat(req.query.price as string) : undefined;

      const analysis = await generateSmartAnalysis({
        symbol,
        exchange,
        marketType,
        timeframe,
        currentPrice,
      });

      res.json({ success: true, data: analysis });
    } catch (err: any) {
      console.error('Error generating smart analysis:', err);
      res.status(500).json({ success: false, error: err.message || 'Failed to generate smart analysis' });
    }
  });

  // Klines endpoint for interactive chart
  app.get('/api/klines', async (req, res) => {
    try {
      const exchange = (req.query.exchange as ExchangeId) || 'binance';
      const market = (req.query.market as MarketType) || 'futures';
      const rawSymbol = (req.query.symbol as string) || 'BTCUSDT';
      const symbol = normalizeExchangeSymbol(rawSymbol);
      const timeframe = (req.query.timeframe as Timeframe) || '1h';
      const limit = req.query.limit ? Math.min(Math.max(parseInt(req.query.limit as string, 10) || 500, 10), 1000) : 500;
      const startTime = req.query.startTime ? parseInt(req.query.startTime as string, 10) : undefined;
      const endTime = req.query.endTime ? parseInt(req.query.endTime as string, 10) : undefined;

      const klines = await fetchKlines(exchange, market, symbol, timeframe, limit, startTime, endTime,
        { chart: true });
      res.json({ success: true, symbol, exchange, timeframe, data: klines });
    } catch (err: any) {
      console.error('Error fetching klines:', err);
      res.status(500).json({ success: false, error: err.message || 'Failed to fetch klines' });
    }
  });

  // Exact rolling trade count from Binance's 24h ticker (null if unsupported).
  app.get('/api/chart/trades24h', async (req, res) => {
    const exchange = String(req.query.exchange || '').toLowerCase();
    const market = String(req.query.market || '').toLowerCase();
    const symbol = String(req.query.symbol || '').toUpperCase();
    if (!['binance', 'bybit'].includes(exchange) || !['spot', 'futures'].includes(market) ||
        !/^[A-Z0-9]{3,30}$/.test(symbol)) {
      return res.status(400).json({ success: false, trades24h: null, error: 'Invalid market or symbol' });
    }
    res.setHeader('Cache-Control', 'public, max-age=30');
    try {
      const trades24h = await fetch24hTradeCount(exchange, market as MarketType, symbol);
      res.json({ success: true, trades24h, source: exchange === 'binance' ? 'binance_24h_ticker' : 'not_available' });
    } catch {
      res.json({ success: true, trades24h: null, source: 'unavailable' });
    }
  });

  // Dual Exchange Open Interest (Binance & Bybit)
  app.get('/api/derivatives/oi', async (req, res) => {
    try {
      const symbol = (req.query.symbol as string) || 'BTCUSDT';
      const baseAsset = (req.query.baseAsset as string) || undefined;
      const price = req.query.price ? parseFloat(req.query.price as string) : undefined;

      const oi = await fetchDualExchangeOI(symbol, baseAsset, price);
      res.json({ success: true, ...oi });
    } catch (err: any) {
      console.error('Error in /api/derivatives/oi:', err);
      res.status(500).json({ success: false, error: err.message || 'Failed to fetch OI' });
    }
  });

  // Historical open-interest candles used by HookChart indicators.
  app.get('/api/derivatives/oi/history', async (req, res) => {
    try {
      const symbol = typeof req.query.symbol === 'string' ? req.query.symbol : 'BTCUSDT';
      const timeframe = typeof req.query.timeframe === 'string' ? req.query.timeframe : '1h';
      if (symbol.length > 80 || !/^[\p{L}\p{M}\p{N}_/-]+$/u.test(symbol)) {
        return res.status(400).json({ success: false, error: 'Invalid symbol' });
      }
      const history = await fetchHookChartOIHistory(symbol, timeframe);
      res.json({ success: true, ...history });
    } catch {
      res.status(503).json({ success: false, error: 'Open interest history is temporarily unavailable' });
    }
  });

  // AI Formation analysis endpoint
  app.post('/api/ai/analyze-formation', async (req, res) => {
    try {
      const { symbol, exchange, timeframe, formation, currentPrice, recentCandles } = req.body;
      if (!symbol || !formation) {
        return res.status(400).json({ error: 'Missing required fields' });
      }

      const analysis = await analyzeFormationWithAI(
        symbol,
        exchange || 'binance',
        timeframe || '1h',
        formation,
        currentPrice || formation.levels?.entryPrice || 0,
        recentCandles || []
      );

      res.json({ success: true, analysis });
    } catch (err: any) {
      console.error('Error analyzing formation with AI:', err);
      res.status(500).json({ success: false, error: err.message || 'AI analysis failed' });
    }
  });

  installTelegramRoutes(app);

  // Price Alerts CRUD endpoints (with per-user scoping)
  app.get('/api/alerts', (req, res) => {
    try {
      const userId = req.query.userId as string | undefined;
      if (!userId || userId === 'guest') {
        return res.json({
          success: true,
          alerts: [],
          isTelegramConfigured: false,
        });
      }
      const alerts = getAllAlerts(userId);
      const userTg = getUserTelegram(userId);
      res.json({
        success: true,
        alerts,
        isTelegramConfigured: Boolean(userTg?.botToken && userTg?.chatId && userTg?.confirmedAt),
      });
    } catch (err: any) {
      res.status(500).json({ success: false, error: err.message });
    }
  });

  // User alerts sync endpoint (connects client-side user alerts to backend background price monitor)
  app.post('/api/alerts/sync', (req, res) => {
    try {
      const { userId, alerts, telegramBotToken, telegramChatId, language } = req.body;
      if (!userId || userId === 'guest' || !Array.isArray(alerts)) {
        return res.status(400).json({ success: false, error: 'Valid userId and alerts array required' });
      }
      const merged = syncUserAlerts(
        userId,
        alerts,
        telegramBotToken,
        telegramChatId,
        language ? normalizeLanguage(language) : undefined
      );
      res.json({ success: true, count: merged.length, alerts: merged });
    } catch (err: any) {
      res.status(500).json({ success: false, error: err.message });
    }
  });

  // Get alert notification history
  app.get('/api/alerts/history', (req, res) => {
    try {
      const userId = req.query.userId as string | undefined;
      if (!userId || userId === 'guest') {
        return res.json({ success: true, history: [] });
      }
      const history = getAlertHistory(userId);
      res.json({ success: true, history });
    } catch (err: any) {
      res.status(500).json({ success: false, error: err.message });
    }
  });

  // Clear alert history
  app.post('/api/alerts/history/clear', (req, res) => {
    try {
      const userId = (req.body?.userId || req.query.userId) as string | undefined;
      const cleared = clearAlertHistory(userId);
      res.json({ success: true, cleared });
    } catch (err: any) {
      res.status(500).json({ success: false, error: err.message });
    }
  });

  // Delete single history item
  app.delete('/api/alerts/history/:id', (req, res) => {
    try {
      const userId = req.query.userId as string | undefined;
      const success = deleteHistoryItem(req.params.id, userId);
      res.json({ success });
    } catch (err: any) {
      res.status(500).json({ success: false, error: err.message });
    }
  });

  app.post('/api/alerts', (req, res) => {
    try {
      const {
        id,
        symbol,
        exchange,
        marketType,
        targetPrice,
        condition,
        note,
        formationName,
        levelType,
        userId,
        telegramBotToken,
        telegramChatId,
        language,
        isActive,
      } = req.body;

      if (!symbol || targetPrice === undefined || !condition) {
        return res.status(400).json({ success: false, error: 'Вкажіть символ, цільову ціну та умову (gte або lte)' });
      }

      const numPrice = parseFloat(targetPrice);
      if (!Number.isFinite(numPrice) || numPrice <= 0 || !['gte', 'lte'].includes(condition)) {
        return res.status(400).json({ success: false, error: 'Цільова ціна повинна бути додатнім числом' });
      }

      if (!userId || userId === 'guest') {
        return res.status(401).json({
          success: false,
          error: 'Встановлення сповіщень доступне тільки для зареєстрованих користувачів. Будь ласка, увійдіть або зареєструйтесь.',
        });
      }

      const alert = createAlert({
        id: id ? String(id).trim() : undefined,
        userId: String(userId),
        symbol: symbol.toUpperCase().replace('/', '').trim(),
        exchange: exchange || 'binance',
        marketType: marketType || 'futures',
        targetPrice: numPrice,
        condition,
        note: note ? String(note).trim() : undefined,
        formationName: formationName ? String(formationName).trim() : undefined,
        levelType: levelType || 'custom',
        telegramBotToken: telegramBotToken ? String(telegramBotToken).trim() : undefined,
        telegramChatId: telegramChatId ? String(telegramChatId).trim() : undefined,
        language: language ? normalizeLanguage(language) : undefined,
        isActive: isActive !== undefined ? Boolean(isActive) : true,
      });

      const cfg = getUserTelegram(userId);
      res.json({
        success: true,
        alert,
        isTelegramConfigured: Boolean(cfg?.botToken && cfg?.chatId && cfg?.confirmedAt),
      });
    } catch (err: any) {
      res.status(500).json({ success: false, error: err.message });
    }
  });

  // Batch create alerts (e.g., all 3 levels: Entry, Take-Profit, Stop-Loss simultaneously)
  app.post('/api/alerts/batch', (req, res) => {
    try {
      const { userId, alerts, telegramBotToken, telegramChatId, language } = req.body;

      if (!userId || userId === 'guest') {
        return res.status(401).json({
          success: false,
          error: 'Встановлення сповіщень доступне тільки для зареєстрованих користувачів. Будь ласка, увійдіть.',
        });
      }

      if (!Array.isArray(alerts) || alerts.length === 0) {
        return res.status(400).json({ success: false, error: 'Масив сповіщень порожній або відсутній' });
      }

      if (alerts.some(a => !a || typeof a.symbol !== 'string' || !a.symbol.trim() ||
        !Number.isFinite(Number(a.targetPrice)) || Number(a.targetPrice) <= 0 || !['gte', 'lte'].includes(a.condition))) {
        return res.status(400).json({ success: false, error: 'Некоректні рівні сповіщень' });
      }
      const created = createAlertsBatch(
        String(userId),
        alerts,
        telegramBotToken,
        telegramChatId,
        language ? normalizeLanguage(language) : undefined
      );
      const cfg = getUserTelegram(userId);
      res.json({
        success: true,
        count: created.length,
        alerts: created,
        isTelegramConfigured: Boolean(cfg?.botToken && cfg?.chatId && cfg?.confirmedAt),
      });
    } catch (err: any) {
      res.status(500).json({ success: false, error: err.message });
    }
  });

  // Atomic 3 Price Alerts group creation (ENTRY, TARGET, STOP) for a setup
  app.post('/api/alerts/setup-group', (req, res) => {
    try {
      const { userId, setup, currentPrice, autoActivate } = req.body;
      if (!userId || userId === 'guest') {
        return res.status(401).json({
          success: false,
          error: 'Встановлення сповіщень доступне тільки для зареєстрованих користувачів.',
        });
      }
      if (!setup) {
        return res.status(400).json({ success: false, error: 'Дані сетапу відсутні' });
      }

      const result = createSetupAlertsGroup(
        String(userId),
        setup,
        currentPrice ? Number(currentPrice) : undefined,
        autoActivate !== undefined ? Boolean(autoActivate) : true
      );

      if (!result.success) {
        return res.status(400).json({ success: false, error: result.error });
      }

      res.json({ success: true, count: result.alerts?.length || 0, alerts: result.alerts });
    } catch (err: any) {
      res.status(500).json({ success: false, error: err.message });
    }
  });

  app.delete('/api/alerts/:id', (req, res) => {
    try {
      const userId = (req.query.userId || req.body?.userId) as string | undefined;
      const success = deleteAlert(req.params.id, userId);
      res.json({ success });
    } catch (err: any) {
      res.status(500).json({ success: false, error: err.message });
    }
  });

  app.post('/api/alerts/:id/toggle', (req, res) => {
    try {
      const userId = req.query.userId as string | undefined;
      const alert = toggleAlert(req.params.id, userId, typeof req.body?.isActive === 'boolean' ? req.body.isActive : undefined);
      if (!alert) {
        return res.status(404).json({ success: false, error: 'Алерт не знайдено' });
      }
      res.json({ success: true, alert });
    } catch (err: any) {
      res.status(500).json({ success: false, error: err.message });
    }
  });

  app.post('/api/alerts/clear-triggered', (req, res) => {
    try {
      const userId = req.query.userId as string | undefined;
      const count = clearTriggeredAlerts(userId);
      res.json({ success: true, count });
    } catch (err: any) {
      res.status(500).json({ success: false, error: err.message });
    }
  });

  // Surveillance endpoints
  app.get('/api/surveillance', (req, res) => {
    try {
      const requestedId = (req.query.userId as string | undefined)?.trim();
      const userId = requestedId && requestedId !== '' ? requestedId : 'guest';
      const list = loadSurveillanceList(userId);
      res.json({ success: true, data: list });
    } catch (err: any) {
      res.status(500).json({ success: false, error: err.message });
    }
  });

  app.post('/api/surveillance', async (req, res) => {
    try {
      const { symbol, baseAsset, quoteAsset, exchange, marketType, userId, config } = req.body;
      const uid = (userId && String(userId).trim()) || 'guest';
      const configError = config === undefined ? null : validateSurveillanceConfig(config);
      if (configError) return res.status(400).json({ success: false, error: configError });
      if (typeof symbol !== 'string' || !symbol.trim()) {
        return res.status(400).json({ success: false, error: 'Тікер монети не вказано' });
      }
      const cleanSymbol = symbol.toUpperCase().replace('/', '').trim();
      if (!/^[A-Z0-9]+$/.test(cleanSymbol) ||
          (exchange && !['binance', 'bybit'].includes(exchange)) ||
          (marketType && !['spot', 'futures'].includes(marketType))) {
        return res.status(400).json({ success: false, error: 'Невірний символ, біржа або ринок' });
      }
      const list = loadSurveillanceList(uid);

      const existing = list.find((c) => c.symbol === cleanSymbol && c.exchange === (exchange || 'binance') && c.marketType === (marketType || 'futures'));
      if (existing) {
        // Coin already on surveillance: ensure it is active and update config/analysis
        existing.isActive = true; // Always active upon user add/resume
        existing.updatedAt = new Date().toISOString();
        if (config) {
          existing.config = { ...existing.config, ...config };
        }
        saveSurveillanceList(uid, list);
        surveillanceManager.startWorkerForCoin(existing);
        const { coin: checked } = await checkCoinSurveillance(existing, true);
        const committed = commitSurveillanceCheck(checked);
        if (!committed) return res.status(404).json({ success: false, error: 'Монету видалено під час перевірки' });
        return res.json({ success: true, coin: committed, message: 'Монету активовано для системного нагляду' });
      }

      const defaultCfg = getDefaultSurveillanceConfig();
      const newCoin = {
        id: `surv_${Date.now()}_${Math.random().toString(36).substring(2, 8)}`,
        userId: uid,
        symbol: cleanSymbol,
        baseAsset: baseAsset || cleanSymbol.replace('USDT', ''),
        quoteAsset: quoteAsset || 'USDT',
        exchange: exchange || 'binance',
        marketType: marketType || 'futures',
        isActive: true, // Always active upon addition until user explicitly pauses or removes
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        config: { ...defaultCfg, ...(config || {}) },
      };

      list.unshift(newCoin);
      saveSurveillanceList(uid, list);
      surveillanceManager.startWorkerForCoin(newCoin);
      const { coin: checkedCoin } = await checkCoinSurveillance(newCoin, true);
      const committed = commitSurveillanceCheck(checkedCoin);
      if (!committed) return res.status(404).json({ success: false, error: 'Монету видалено під час перевірки' });

      res.json({ success: true, coin: committed, message: 'Монету успішно додано на 24/7 системний нагляд!' });
    } catch (err: any) {
      res.status(500).json({ success: false, error: err.message });
    }
  });

  app.put('/api/surveillance/:id', async (req, res) => {
    try {
      const { id } = req.params;
      const { userId, config, isActive } = req.body;
      const configError = config === undefined ? null : validateSurveillanceConfig(config);
      if (configError) return res.status(400).json({ success: false, error: configError });
      const found = findSurveillanceCoinById(id, userId);

      if (!found) {
        return res.status(404).json({ success: false, error: 'Монету не знайдено в нагляді' });
      }

      const coin = found.coin;
      const nextActive = isActive !== undefined ? Boolean(isActive) : coin.isActive;
      const updatedCoin = {
        ...coin,
        isActive: nextActive,
        config: config ? { ...coin.config, ...config } : coin.config,
        updatedAt: new Date().toISOString(),
      };

      found.list[found.index] = updatedCoin;
      saveSurveillanceList(found.userId, found.list);

      // Keep 24/7 worker synced with updated coin config & active state (#4)
      if (updatedCoin.isActive) {
        surveillanceManager.startWorkerForCoin(updatedCoin);
      } else {
        surveillanceManager.stopWorkerForCoin(updatedCoin.id, updatedCoin.userId);
      }

      res.json({ success: true, coin: updatedCoin });
    } catch (err: any) {
      res.status(500).json({ success: false, error: err.message });
    }
  });

  // Batch toggle all coins active/paused for user
  app.post('/api/surveillance/toggle-all', (req, res) => {
    try {
      const { userId, isActive } = req.body;
      const uid = (userId && String(userId).trim()) || 'guest';
      const updatedList = setAllSurveillanceCoinsActive(uid, Boolean(isActive));
      res.json({ success: true, data: updatedList });
    } catch (err: any) {
      res.status(500).json({ success: false, error: err.message });
    }
  });

  app.delete('/api/surveillance/:id', (req, res) => {
    try {
      const { id } = req.params;
      const userId = (req.query.userId as string) || req.body?.userId;
      const found = findSurveillanceCoinById(id, userId);

      if (!found) {
        return res.status(404).json({ success: false, error: 'Монету не знайдено в нагляді' });
      }

      const filtered = found.list.filter((c) => c.id !== id);
      saveSurveillanceList(found.userId, filtered);
      surveillanceManager.stopWorkerForCoin(id, found.userId);
      res.json({ success: true });
    } catch (err: any) {
      res.status(500).json({ success: false, error: err.message });
    }
  });

  app.post('/api/surveillance/check-all', async (req, res) => {
    try {
      const { userId } = req.body;
      const uid = userId || 'guest';
      const updatedList = await checkAllUserCoins(uid);
      res.json({ success: true, data: updatedList });
    } catch (err: any) {
      res.status(500).json({ success: false, error: err.message });
    }
  });

  app.post('/api/surveillance/:id/check', async (req, res) => {
    try {
      const { id } = req.params;
      const { userId, forceNotify } = req.body;
      const found = findSurveillanceCoinById(id, userId);

      if (!found) {
        return res.status(404).json({ success: false, error: 'Монету не знайдено' });
      }

      // #6: Single coin manual check explicitly supports forceNotify if requested by user
      const { coin: updated } = await checkCoinSurveillance(found.coin, {
        forceCheck: true,
        forceNotify: Boolean(forceNotify),
      });
      const committed = commitSurveillanceCheck(updated);
      if (!committed) return res.status(404).json({ success: false, error: 'Монету видалено під час перевірки' });

      res.json({ success: true, coin: committed });
    } catch (err: any) {
      res.status(500).json({ success: false, error: err.message });
    }
  });

  // Granular live worker snapshot (orderbook, trade flow, densities, setups, OI)
  app.get('/api/surveillance/worker/:id', (req, res) => {
    try {
      const { id } = req.params;
      const userId = typeof req.query.userId === 'string' ? req.query.userId : 'guest';
      const snapshot = surveillanceManager.getWorkerSnapshot(id, userId);
      if (snapshot && snapshot.userId !== userId) {
        return res.status(404).json({ success: false, error: 'Worker not found' });
      }
      if (!snapshot) {
        return res.status(404).json({ success: false, error: 'Worker not found or not active' });
      }
      res.json({ success: true, data: snapshot });
    } catch (err: any) {
      res.status(500).json({ success: false, error: err.message });
    }
  });

  // Causal historical replay / backtest without look-ahead bias
  app.post('/api/surveillance/backtest', async (req, res) => {
    try {
      const { symbol, exchange, marketType, timeframe } = req.body;
      if (typeof symbol !== 'string' || !symbol.trim()) {
        return res.status(400).json({ success: false, error: 'Оберіть монету для бектесту' });
      }
      const sym = symbol.toUpperCase().trim();
      const ex = exchange || 'binance';
      const mkt = marketType || 'futures';
      const tf = timeframe || '15m';
      if (!/^[\p{L}\p{M}\p{N}]+$/u.test(sym) || !['binance', 'bybit'].includes(ex) ||
          !['spot', 'futures'].includes(mkt) || !['1m', '5m', '15m', '1h', '4h'].includes(tf)) {
        return res.status(400).json({ success: false, error: 'Невірні параметри бектесту' });
      }

      const asOf = Date.now();
      const klines = await fetchKlines(ex, mkt, sym, tf, tf === '1m' ? 500 : 200,
        undefined, undefined, { requireFresh: true }).catch(() => []);
      if (klines.length < 50) {
        return res.status(503).json({ success: false, error: 'Недостатньо історичних даних з обраної біржі' });
      }
      const result = surveillanceReplayEngine.runCausalBacktest(sym, klines, tf, asOf);
      if (result.closedCandles < 50) {
        return res.status(503).json({ success: false, error: 'Недостатньо коректних закритих свічок з обраної біржі' });
      }
      res.json({ success: true, data: { ...result, exchange: ex, marketType: mkt, symbol: sym } });
    } catch (err: any) {
      res.status(500).json({ success: false, error: err.message });
    }
  });

  // Get aggregated surveillance events across all tracked coins for user
  app.get('/api/surveillance/events', (req, res) => {
    try {
      const { userId } = req.query;
      const uid = typeof userId === 'string' && userId.trim() ? userId.trim() : 'guest';
      const coins = loadSurveillanceList(uid);
      const allEvents: any[] = [];

      for (const coin of coins) {
        if (coin.state?.recentEvents && Array.isArray(coin.state.recentEvents)) {
          for (const ev of coin.state.recentEvents) {
            allEvents.push({
              ...ev,
              coinId: coin.id,
              symbol: coin.symbol,
              baseAsset: coin.baseAsset,
              quoteAsset: coin.quoteAsset,
              exchange: coin.exchange,
              marketType: coin.marketType,
            });
          }
        }
      }

      allEvents.sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0));
      res.json({ success: true, data: allEvents });
    } catch (err: any) {
      res.status(500).json({ success: false, error: err.message });
    }
  });

  // Vite middleware setup
  if (process.env.NODE_ENV !== 'production') {
    const vite = await createViteServer({
      server: {
        middlewareMode: true,
        watch: {
          ignored: ['**/server/data/**'],
        },
      },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(process.cwd(), 'dist');
    installProductionAssets(app, distPath);
  }

  const httpServer = app.listen(PORT, '0.0.0.0', () => {
    console.log(`Crypto Pattern Screener server running on http://0.0.0.0:${PORT}`);
    // Start unified background CRON for all notifications (Price Alerts 5s, Surveillance 15s, Screener 60s)
    startTelegramDeliveryWorker();
    startSharedTelegramBot();
    cronManager.init();
    formationDensityFeed.start();
    binanceTickerStream.start();
  });
  const depthFeed = installHookChartDepthStream(httpServer);
  installLiquidationStream(httpServer);
  if (process.env.NODE_ENV === 'production') {
    // Both site WebSocket handlers use noServer routing. Do not leave unknown
    // upgrade paths hanging with an open socket on a public VPS.
    httpServer.on('upgrade', (request, socket) => {
      const pathname = (request.url || '').split('?')[0];
      if (pathname !== '/api/hookchart/depth' && pathname !== '/api/hookchart/liquidations') {
        socket.destroy();
      }
    });
  }
  chartDepthMetrics = () => ({
    activeMarkets: depthFeed.activeMarkets(), clients: depthFeed.activeClients(),
  });
}

startServer();

