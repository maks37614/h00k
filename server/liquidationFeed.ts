import fs from 'node:fs';
import path from 'node:path';
import type { Server } from 'node:http';
import WebSocket, { WebSocketServer } from 'ws';

export type LiquidationRow = {
  id: string; side: 'LONG' | 'SHORT'; t: number; p: number; q: number; usd: number;
};
type Exchange = 'binance' | 'bybit';
type Entry = {
  key: string; exchange: Exchange; symbol: string;
  rows: LiquidationRow[]; clients: Set<WebSocket>;
  upstream: WebSocket | null; ping: ReturnType<typeof setInterval> | null;
  reconnect: ReturnType<typeof setTimeout> | null;
  failures: number; idleAt: number; lastEventAt: number;
};
const RETAIN_MS = 30 * 60_000;
const MAX_ROWS = 1500;
const IDLE_GRACE_MS = 30 * 60_000;
const MAX_MARKETS = 64;
const MAX_CLIENTS = 2000;
const STORE_FILE = path.join(process.cwd(), 'server', 'data', 'liquidations.json');

/** Normalize exchange messages once on the server, never fabricate unavailable trades. */
export function parseLiquidations(exchange: Exchange, symbol: string, payload: unknown): LiquidationRow[] {
  if (!payload || typeof payload !== 'object') return [];
  const msg = payload as Record<string, any>;
  const rows: LiquidationRow[] = [];
  if (exchange === 'binance') {
    const order = msg.o;
    if (!order || String(order.s).toUpperCase() !== symbol) return [];
    const p = Number(order.ap || order.L || order.p || 0);
    const z = Number(order.z || 0), last = Number(order.l || 0);
    const q = z > 0 ? z : last > 0 ? last : Number(order.q || 0);
    const t = Number(order.T || msg.E);
    rows.push({
      id: `bin:${symbol}:${String(order.i ?? order.T ?? msg.E ?? t)}`,
      side: String(order.S).toUpperCase() === 'SELL' ? 'LONG' : 'SHORT',
      t, p, q, usd: p * q,
    });
  } else if (msg.topic === `allLiquidation.${symbol}` && Array.isArray(msg.data)) {
    for (let index = 0; index < msg.data.length; index++) {
      const row = msg.data[index];
      const p = Number(row?.p), q = Number(row?.v), t = Number(row?.T ?? msg.ts);
      rows.push({
        id: `byb:${symbol}:${t}:${row?.S}:${row?.p}:${row?.v}:${index}`,
        side: String(row?.S).toLowerCase() === 'buy' ? 'LONG' : 'SHORT',
        t, p, q, usd: p * q,
      });
    }
  }
  const now = Date.now();
  return rows.filter(row => Number.isFinite(row.p) && row.p > 0 &&
    Number.isFinite(row.q) && row.q > 0 && Number.isSafeInteger(row.t) &&
    row.t <= now + 2000 && row.t >= now - RETAIN_MS &&
    Number.isFinite(row.usd) && row.usd > 0);
}

export class SharedLiquidationFeed {
  private entries = new Map<string, Entry>();
  private counters = { upstreamConnections: 0, reconnects: 0, received: 0, duplicates: 0,
    rejectedClients: 0, savedSnapshots: 0, failedSaves: 0 };
  private writing: Promise<void> | null = null;

  constructor() {
    try {
      const saved = JSON.parse(fs.readFileSync(STORE_FILE, 'utf8')) as Record<string, LiquidationRow[]>;
      if (saved && typeof saved === 'object' && !Array.isArray(saved)) {
        for (const [key, rows] of Object.entries(saved).slice(0, MAX_MARKETS)) {
          const [exchange, symbol] = key.split(':');
          if (!['binance', 'bybit'].includes(exchange) || !/^[A-Z0-9]{3,30}$/.test(symbol) ||
              !Array.isArray(rows)) continue;
          const valid = rows.slice(-MAX_ROWS).filter(row =>
            row && typeof row.id === 'string' && ['LONG', 'SHORT'].includes(row.side) &&
            Number.isFinite(row.usd) && row.usd > 0 && Number.isSafeInteger(row.t) &&
            Date.now() - row.t >= 0 && Date.now() - row.t <= RETAIN_MS);
          if (valid.length) this.entries.set(key, this.makeEntry(exchange as Exchange, symbol, valid));
        }
      }
    } catch { /* no saved history yet */ }
  }

  private makeEntry(exchange: Exchange, symbol: string, rows: LiquidationRow[] = []): Entry {
    return { key: `${exchange}:${symbol}`, exchange, symbol, rows, clients: new Set(),
      upstream: null, ping: null, reconnect: null, failures: 0,
      idleAt: Date.now(), lastEventAt: rows.length ? Math.max(...rows.map(r => r.t)) : 0 };
  }

  stats() {
    const all = [...this.entries.values()];
    return { ...this.counters, activeMarkets: all.length,
      connectedMarkets: all.filter(e => e.upstream?.readyState === WebSocket.OPEN).length,
      viewers: all.reduce((count, e) => count + e.clients.size, 0),
      storedEvents: all.reduce((count, e) => count + e.rows.length, 0),
      byInstrument: all.map(e => ({ source: e.key, viewers: e.clients.size,
        connected: e.upstream?.readyState === WebSocket.OPEN, events: e.rows.length,
        lastEventAt: e.lastEventAt || null })) };
  }

  private send(client: WebSocket, packet: unknown) {
    if (client.readyState !== WebSocket.OPEN) return;
    if (client.bufferedAmount > 1_000_000) { client.close(1013, 'Slow consumer'); return; }
    client.send(JSON.stringify(packet));
  }

  private broadcast(entry: Entry, packet: unknown) {
    const encoded = JSON.stringify(packet);
    for (const client of entry.clients) {
      if (client.readyState !== WebSocket.OPEN) continue;
      if (client.bufferedAmount > 1_000_000) client.close(1013, 'Slow consumer');
      else client.send(encoded);
    }
  }

  private prune(entry: Entry) {
    const cutoff = Date.now() - RETAIN_MS;
    entry.rows = entry.rows.filter(row => row.t >= cutoff).slice(-MAX_ROWS);
  }

  private onRows(entry: Entry, rows: LiquidationRow[]) {
    for (const row of rows) {
      const previous = entry.rows.findIndex(old => old.id === row.id);
      if (previous >= 0) {
        const old = entry.rows[previous];
        // A partially-filled liquidation order can be reported again with a
        // larger cumulative fill; replace it rather than double-counting.
        if (row.q <= old.q) { this.counters.duplicates++; continue; }
        entry.rows[previous] = row;
      } else entry.rows.push(row);
      entry.lastEventAt = Math.max(entry.lastEventAt, row.t);
      this.counters.received++;
      this.broadcast(entry, { type: 'liquidation', event: row });
    }
    this.prune(entry);
  }

  private stopUpstream(entry: Entry) {
    if (entry.reconnect) clearTimeout(entry.reconnect);
    entry.reconnect = null;
    if (entry.ping) clearInterval(entry.ping);
    entry.ping = null;
    const socket = entry.upstream;
    entry.upstream = null;
    if (socket) { try { socket.terminate(); } catch {} }
  }

  private connect(entry: Entry) {
    if (entry.upstream || entry.reconnect) return;
    const url = entry.exchange === 'binance'
      ? `wss://fstream.binance.com/market/ws/${entry.symbol.toLowerCase()}@forceOrder`
      : 'wss://stream.bybit.com/v5/public/linear';
    let socket: WebSocket;
    try { socket = new WebSocket(url, { handshakeTimeout: 10_000, perMessageDeflate: false }); }
    catch { this.retry(entry); return; }
    entry.upstream = socket;
    this.counters.upstreamConnections++;
    socket.on('open', () => {
      if (entry.upstream !== socket) return;
      entry.failures = 0;
      if (entry.exchange === 'bybit') {
        socket.send(JSON.stringify({ op: 'subscribe', args: [`allLiquidation.${entry.symbol}`] }));
        entry.ping = setInterval(() => {
          if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ op: 'ping' }));
        }, 20_000);
        entry.ping.unref?.();
      }
      this.broadcast(entry, { type: 'status', connected: true });
    });
    socket.on('message', data => {
      if (entry.upstream !== socket) return;
      try {
        const packet = JSON.parse(data.toString());
        if (entry.exchange === 'bybit' && packet?.op === 'subscribe' && packet?.success === false) {
          console.warn(`[LiquidationFeed] Bybit rejected subscription for ${entry.symbol}`);
          socket.terminate();
          return;
        }
        this.onRows(entry, parseLiquidations(entry.exchange, entry.symbol, packet));
      } catch { /* invalid market payload */ }
    });
    socket.on('error', () => { if (entry.upstream === socket) try { socket.close(); } catch {} });
    socket.on('close', () => {
      if (entry.upstream !== socket) return;
      entry.upstream = null;
      if (entry.ping) clearInterval(entry.ping);
      entry.ping = null;
      this.broadcast(entry, { type: 'status', connected: false });
      if (entry.clients.size || Date.now() - entry.idleAt < IDLE_GRACE_MS) this.retry(entry);
    });
  }

  private retry(entry: Entry) {
    if (entry.reconnect) return;
    const delay = Math.min(30_000, 1000 * 2 ** Math.min(entry.failures++, 5));
    this.counters.reconnects++;
    entry.reconnect = setTimeout(() => {
      entry.reconnect = null;
      if (this.entries.get(entry.key) === entry &&
          (entry.clients.size || Date.now() - entry.idleAt < IDLE_GRACE_MS)) this.connect(entry);
    }, delay + Math.floor(Math.random() * 300));
    entry.reconnect.unref?.();
  }

  addClient(client: WebSocket, exchange: Exchange, symbol: string) {
    const key = `${exchange}:${symbol}`;
    let entry = this.entries.get(key);
    if (!entry && this.entries.size >= MAX_MARKETS) {
      const idle = [...this.entries.values()].filter(e => !e.clients.size)
        .sort((a, b) => a.idleAt - b.idleAt)[0];
      if (idle) { this.stopUpstream(idle); this.entries.delete(idle.key); }
    }
    if (!entry && this.entries.size >= MAX_MARKETS) {
      this.counters.rejectedClients++;
      client.close(1013, 'Liquidation market capacity reached');
      return;
    }
    if (!entry) {
      entry = this.makeEntry(exchange, symbol);
      this.entries.set(key, entry);
    }
    entry.clients.add(client);
    this.prune(entry);
    this.send(client, { type: 'snapshot', events: entry.rows,
      connected: entry.upstream?.readyState === WebSocket.OPEN });
    if (!entry.upstream && !entry.reconnect) this.connect(entry);
    const current = entry;
    client.on('message', () => client.close(1008, 'Read-only stream'));
    client.on('close', () => {
      current.clients.delete(client);
      if (!current.clients.size) current.idleAt = Date.now();
    });
  }

  startPersistence() {
    const timer = setInterval(() => {
      for (const [key, entry] of this.entries) {
        this.prune(entry);
        if (!entry.clients.size && Date.now() - entry.idleAt >= IDLE_GRACE_MS) {
          this.stopUpstream(entry);
          if (!entry.rows.length) this.entries.delete(key);
        }
      }
      void this.save();
    }, 30_000);
    timer.unref?.();
  }

  private async save(): Promise<void> {
    if (this.writing) return this.writing;
    const rows = Object.fromEntries([...this.entries].map(([key, entry]) => [key, entry.rows])
      .filter(([, data]) => (data as LiquidationRow[]).length));
    const pending = (async () => {
      try {
        await fs.promises.mkdir(path.dirname(STORE_FILE), { recursive: true });
        const temp = STORE_FILE + '.tmp';
        await fs.promises.writeFile(temp, JSON.stringify(rows), 'utf8');
        await fs.promises.rename(temp, STORE_FILE);
        this.counters.savedSnapshots++;
      } catch (error) {
        this.counters.failedSaves++;
        console.warn('[LiquidationFeed] Unable to persist recent history:',
          error instanceof Error ? error.message : String(error));
      }
    })();
    this.writing = pending;
    try { await pending; } finally { this.writing = null; }
  }
}

export const liquidationFeed = new SharedLiquidationFeed();

export function installLiquidationStream(server: Server) {
  const sockets = new WebSocketServer({ noServer: true, maxPayload: 1024 });
  server.on('upgrade', (request, socket, head) => {
    const pathname = (request.url || '').split('?')[0];
    if (pathname !== '/api/hookchart/liquidations') return;
    sockets.handleUpgrade(request, socket, head, client => sockets.emit('connection', client, request));
  });
  sockets.on('connection', (client, request) => {
    if (sockets.clients.size > MAX_CLIENTS) {
      client.close(1013, 'Liquidation clients capacity reached');
      return;
    }
    const url = new URL(request.url || '/', 'http://localhost');
    const exchange = url.searchParams.get('exchange');
    const symbol = (url.searchParams.get('symbol') || '').toUpperCase();
    if ((exchange !== 'binance' && exchange !== 'bybit') || !/^[A-Z0-9]{3,30}$/.test(symbol)) {
      client.close(1008, 'Invalid exchange or symbol');
      return;
    }
    liquidationFeed.addClient(client, exchange, symbol);
  });
  liquidationFeed.startPersistence();
  return liquidationFeed;
}
