import type { BookUpdate } from '../../utils/binanceOrderBook';
import { chartDepthScope, type ChartDepthStatus } from '../../utils/hookChartDepthProtocol';
import { isFreshDepthTime, parseDepthLevels } from '../../utils/orderBookValidation';
import { connectHookChartDepth } from './depthStream';

type Options = Parameters<typeof connectHookChartDepth>[0];
type Subscriber = Pick<Options, 'onBook' | 'onStatus'>;
type Connector = (options: Options) => () => void;

type Entry = {
  listeners: Set<Subscriber>;
  status: ChartDepthStatus;
  sequence: number;
  eventTime: number;
  bids: Map<number, number>;
  asks: Map<number, number>;
  stop: () => void;
};

function currentSnapshot(entry: Entry): BookUpdate | null {
  if (entry.status !== 'live' || !entry.sequence || !isFreshDepthTime(entry.eventTime) ||
      !entry.bids.size || !entry.asks.size) return null;
  return {
    isSnapshot: true,
    sequence: entry.sequence,
    eventTime: entry.eventTime,
    bids: [...entry.bids],
    asks: [...entry.asks],
  };
}

/**
 * One server-bound depth WS per exchange/market/symbol in a browser tab.
 * Every chart retains an independent HookChartDensityBook (and settings), but
 * new charts join using a complete fresh local book, not an orphan delta.
 */
export function createSharedDepthSubscriptions(connect: Connector = connectHookChartDepth) {
  const active = new Map<string, Entry>();

  const subscribe = (options: Options): (() => void) => {
    const scope = chartDepthScope(options.exchange, options.marketType, options.symbol);
    const key = (options.origin || '') + '|' + scope;
    const listener: Subscriber = { onBook: options.onBook, onStatus: options.onStatus };
    let entry = active.get(key);
    if (entry) {
      entry.listeners.add(listener);
      const snapshot = currentSnapshot(entry);
      if (snapshot) {
        // The book always precedes LIVE: a chart cannot claim live liquidity
        // before its own local density engine has accepted that snapshot.
        try {
          if (listener.onBook(snapshot)) listener.onStatus('live');
          else listener.onStatus('reconnecting');
        } catch { listener.onStatus('reconnecting'); }
      } else listener.onStatus(entry.status === 'live' ? 'reconnecting' : entry.status);
      return () => {
        entry!.listeners.delete(listener);
        if (entry!.listeners.size === 0 && active.get(key) === entry) {
          active.delete(key);
          entry!.stop();
        }
      };
    }

    entry = {
      listeners: new Set([listener]), status: 'connecting', sequence: 0,
      eventTime: 0, bids: new Map(), asks: new Map(), stop: () => {},
    };
    const current = entry;
    active.set(key, current);
    const clear = () => {
      current.sequence = 0;
      current.eventTime = 0;
      current.bids.clear();
      current.asks.clear();
    };
    const fanoutStatus = (status: ChartDepthStatus) => {
      current.status = status;
      if (status !== 'live') clear();
      for (const subscriber of [...current.listeners]) {
        try { subscriber.onStatus(status); } catch { /* a chart never interrupts other charts */ }
      }
    };
    try {
      current.stop = connect({
        ...options,
        onBook: update => {
          const bids = parseDepthLevels(update.bids);
          const asks = parseDepthLevels(update.asks);
          const eventTime = update.eventTime ?? Date.now();
          if (!bids || !asks || !Number.isSafeInteger(update.sequence) || update.sequence <= 0 ||
              !isFreshDepthTime(eventTime)) {
            clear();
            return false;
          }
          if (update.isSnapshot) clear();
          else if (!current.sequence) return false;
          else if (update.sequence <= current.sequence) return true;
          const apply = (rows: [number, number][], levels: Map<number, number>) => {
            for (const [price, size] of rows) {
              if (size > 0) levels.set(price, size);
              else levels.delete(price);
            }
          };
          apply(bids, current.bids);
          apply(asks, current.asks);
          if (!current.bids.size || !current.asks.size ||
              Math.max(...current.bids.keys()) >= Math.min(...current.asks.keys())) {
            clear();
            return false;
          }
          current.sequence = update.sequence;
          current.eventTime = eventTime;
          for (const subscriber of [...current.listeners]) {
            try {
              if (!subscriber.onBook(update)) {
                // A single chart may be mounted late or have lost its local
                // book. Repair it from an exact full snapshot rather than
                // reconnecting the socket for everybody.
                const snapshot = {
                  isSnapshot: true, sequence: current.sequence, eventTime,
                  bids: [...current.bids], asks: [...current.asks],
                };
                if (!subscriber.onBook(snapshot)) subscriber.onStatus('reconnecting');
              }
            } catch {
              try { subscriber.onStatus('reconnecting'); } catch {}
            }
          }
          return true;
        },
        onStatus: fanoutStatus,
      });
    } catch {
      active.delete(key);
      fanoutStatus('unavailable');
    }
    return () => {
      current.listeners.delete(listener);
      if (current.listeners.size === 0 && active.get(key) === current) {
        active.delete(key);
        current.stop();
      }
    };
  };

  return { subscribe, activeScopes: () => active.size };
}

export const connectSharedHookChartDepth = createSharedDepthSubscriptions().subscribe;
