import { ExchangeId, MarketType } from '../../src/types';
import { RawDepthDelta } from './exchangeStream';
import { DensityItem, OrderBookLevel, OrderBookState, OrderBookStatus } from './types';
import { isFreshDepthTime, parseDepthLevels } from '../../src/utils/orderBookValidation';
import { lowerMedian } from './lowerMedian';

export interface DensityConfig {
  mode: 'AUTO' | 'MANUAL' | 'HYBRID';
  manualThresholdUsd: number;
  minPersistenceSeconds: number;
  minDistancePct: number;
}

interface DensityStats {
  firstSeenAt: number;
  lastSeenAt: number;
  samples: number;
  presentSamples: number;
  sizeSumUsd: number;
  maxSizeUsd: number;
  lastSizeUsd: number;
  lastSizeChangeAt: number;
  cancellations: number;
  replenishments: number;
  nearestApproachPct: number;
}

export class OrderBookEngine {
  private bids = new Map<number, number>();
  private asks = new Map<number, number>();
  private activeDensities = new Map<string, DensityItem>();
  private densityHistory: DensityItem[] = [];
  private densityStats = new Map<string, DensityStats>();

  public bestBid = 0;
  public bestAsk = 0;
  public spread = 0;
  public spreadPct = 0;
  public lastUpdateId = 0;
  public lastReceivedAt = 0;
  public lastExchangeTimestamp = 0;
  public dataValid = false;
  public sequenceGap = false;
  public status: OrderBookStatus = 'CONNECTING';
  private volume24hUsd = 0;
  private bookRevision = 0;
  private thresholdMemo: {revision: number; volume: number; mode: string;
    manual: number; value: number} | null = null;
  private medianComputations = 0;
  // OrderBookState and imbalance callers may both request the same top
  // levels many times between depth packets. Cache *price ordering only*;
  // return new level objects so consumers cannot mutate another read.
  private sortedPricesMemo: {
    revision: number; bids?: number[]; asks?: number[];
  } | null = null;
  private sortedPriceComputations = 0;
  private bestPriceFullScans = 0;

  constructor(
    public readonly symbol: string,
    public readonly exchange: ExchangeId,
    public readonly marketType: MarketType,
    private config: DensityConfig = {
      mode: 'AUTO', manualThresholdUsd: 1000000, minPersistenceSeconds: 15, minDistancePct: 0.1,
    }
  ) {}

  public updateConfig(newConfig: Partial<DensityConfig>) {
    const previous = JSON.stringify(this.config);
    this.config = { ...this.config, ...newConfig };
    if (!(this.config.manualThresholdUsd > 0) || !Number.isFinite(this.config.manualThresholdUsd)) this.config.manualThresholdUsd = 1000000;
    if (previous !== JSON.stringify(this.config)) {
      this.thresholdMemo = null;
      if (this.dataValid && Date.now() - this.lastReceivedAt <= 5000) this.evaluateDensities();
    }
  }
  public setVolume24hUsd(volume: number) {
    const next = Number.isFinite(volume) && volume > 0 ? volume : 0;
    if (this.volume24hUsd !== next) {
      this.volume24hUsd = next;
      this.thresholdMemo = null;
    }
  }
  public setStatus(newStatus: OrderBookStatus) {
    this.status = newStatus;
    if (newStatus !== 'LIVE') {
      this.dataValid = false;
      this.activeDensities.clear();
      this.densityStats.clear();
      this.newlyAppearedDensities = [];
    }
  }

  public applyDepth(delta: RawDepthDelta) {
    const now = Date.now();
    // Exchange fallback packets may contain numeric strings. Validating them
    // and then iterating the original tuples silently drops all string levels.
    // Apply only the normalized numeric levels used in validation.
    const bids = parseDepthLevels(delta.bids);
    const asks = parseDepthLevels(delta.asks);
    if (!Number.isSafeInteger(delta.sequence) || delta.sequence! <= 0 ||
        !bids || !asks ||
        (delta.eventTime !== undefined && !isFreshDepthTime(delta.eventTime, now))) {
      this.sequenceGap = true;
      this.setStatus(delta.eventTime !== undefined && !isFreshDepthTime(delta.eventTime, now) ? 'STALE' : 'RESYNCING');
      return;
    }
    if (this.lastReceivedAt && now - this.lastReceivedAt > 5000) {
      this.activeDensities.clear(); this.densityStats.clear(); this.newlyAppearedDensities = [];
    }
    const seq = delta.sequence!;
    // Old/duplicate deltas are harmless; never invalidate a good book for them.
    if (!delta.isSnapshot && this.lastUpdateId > 0 && seq <= this.lastUpdateId) return;
    if (!delta.isSnapshot && (this.lastUpdateId === 0 || this.sequenceGap)) {
      this.status = 'SYNCING';
      return;
    }
    this.lastReceivedAt = now;
    this.bookRevision++;
    this.thresholdMemo = null;
    this.sortedPricesMemo = null;
    this.lastExchangeTimestamp = delta.eventTime || 0;
    this.sequenceGap = false;
    this.lastUpdateId = seq;
    if (delta.isSnapshot) {
      this.bids.clear();
      this.asks.clear();
      this.activeDensities.clear();
      this.densityStats.clear();
      this.newlyAppearedDensities = [];
      this.dataValid = true;
      this.status = 'SYNCING';
    }

    // Most incremental depth packets do not remove the current best price.
    // Track top-of-book directly from changed levels; only search the whole
    // side when that exact best price is deleted. A snapshot starts afresh.
    let bestBid = delta.isSnapshot ? 0 : this.bestBid;
    let bestAsk = delta.isSnapshot ? Infinity : (this.bestAsk || Infinity);
    let bidDeletedAtBest = false;
    let askDeletedAtBest = false;
    for (const [price, qty] of bids) {
      if (!Number.isFinite(price) || price <= 0 ||
          !Number.isFinite(qty) || qty < 0) continue;
      if (qty === 0) {
        this.bids.delete(price);
        if (price === bestBid) bidDeletedAtBest = true;
      } else {
        this.bids.set(price, qty);
        if (price > bestBid) bestBid = price;
      }
    }
    for (const [price, qty] of asks) {
      if (!Number.isFinite(price) || price <= 0 ||
          !Number.isFinite(qty) || qty < 0) continue;
      if (qty === 0) {
        this.asks.delete(price);
        if (price === bestAsk) askDeletedAtBest = true;
      } else {
        this.asks.set(price, qty);
        if (price < bestAsk) bestAsk = price;
      }
    }
    if (bidDeletedAtBest) {
      bestBid = 0;
      for (const price of this.bids.keys()) if (price > bestBid) bestBid = price;
      this.bestPriceFullScans++;
    }
    if (askDeletedAtBest) {
      bestAsk = Infinity;
      for (const price of this.asks.keys()) if (price < bestAsk) bestAsk = price;
      this.bestPriceFullScans++;
    }
    this.bestBid = bestBid;
    this.bestAsk = bestAsk === Infinity ? 0 : bestAsk;
    if (this.bestBid > 0 && this.bestAsk > this.bestBid) {
      this.spread = this.bestAsk - this.bestBid;
      this.spreadPct = (this.spread / this.bestBid) * 100;
      this.status = 'LIVE';
      this.dataValid = true;
    } else {
      this.sequenceGap = true;
      this.setStatus('RESYNCING');
    }
    if (this.dataValid) this.evaluateDensities();
  }

  private getSortedPrices(side: 'bids' | 'asks'): number[] {
    let memo = this.sortedPricesMemo;
    if (!memo || memo.revision !== this.bookRevision) {
      memo = { revision: this.bookRevision };
      this.sortedPricesMemo = memo;
    }
    if (!memo[side]) {
      memo[side] = Array.from((side === 'bids' ? this.bids : this.asks).keys())
        .sort(side === 'bids' ? (a,b)=>b-a : (a,b)=>a-b);
      this.sortedPriceComputations++;
    }
    return memo[side]!;
  }

  public getSortedBids(limit = 30): OrderBookLevel[] {
    return this.getSortedPrices('bids').slice(0,limit).map(price=>{
      const quantity = this.bids.get(price) || 0;
      return {price,quantity,notionalUsd:price*quantity};
    });
  }
  public getSortedAsks(limit = 30): OrderBookLevel[] {
    return this.getSortedPrices('asks').slice(0,limit).map(price=>{
      const quantity = this.asks.get(price) || 0;
      return {price,quantity,notionalUsd:price*quantity};
    });
  }

  public getState(): OrderBookState {
    if (this.lastReceivedAt > 0 && !this.hasFreshData()) this.setStatus('STALE');
    const live = this.dataValid && this.status === 'LIVE';
    return {
      symbol:this.symbol, exchange:this.exchange, marketType:this.marketType,
      bids:live ? this.getSortedBids(20) : [], asks:live ? this.getSortedAsks(20) : [], bestBid:live ? this.bestBid : 0, bestAsk:live ? this.bestAsk : 0,
      spread:live ? this.spread : 0, spreadPct:live ? Number(this.spreadPct.toFixed(4)) : 0, lastUpdateId:this.lastUpdateId,
      sequence:this.lastUpdateId, timestamp:this.lastExchangeTimestamp || this.lastReceivedAt, status:this.status, lastReceivedAt:this.lastReceivedAt,
      dataValid: this.dataValid, sequenceGap: this.sequenceGap,
      bidDepth: this.bids.size, askDepth: this.asks.size,
    };
  }

  public calculateAdaptiveThreshold(volume24hUsd = this.volume24hUsd): number {
    if (this.config.mode === 'MANUAL') return this.config.manualThresholdUsd;
    const memo = this.thresholdMemo;
    if (memo && memo.revision === this.bookRevision &&
      memo.volume === volume24hUsd && memo.mode === this.config.mode &&
      memo.manual === this.config.manualThresholdUsd) return memo.value;
    const all = [...Array.from(this.bids, ([p,q])=>p*q), ...Array.from(this.asks, ([p,q])=>p*q)];
    if (!all.length) return this.config.manualThresholdUsd || 1000000;
    // Exact lower median (including even-length books), without sorting every level.
    // A large wall must not raise its own detection threshold above itself.
    const median = lowerMedian(all);
    this.medianComputations++;
    const turnoverBaseline = volume24hUsd > 0 ? Math.max(1000, volume24hUsd * 0.0001) : 1000;
    const autoVal = Math.max(turnoverBaseline, median * 5);
    // #13: HYBRID takes the maximum so manual threshold is strictly respected and never diluted
    const value = this.config.mode === 'HYBRID'
      ? Math.max(this.config.manualThresholdUsd, autoVal) : autoVal;
    this.thresholdMemo = { revision: this.bookRevision, volume: volume24hUsd,
      mode: this.config.mode, manual: this.config.manualThresholdUsd, value };
    return value;
  }

  public thresholdStats() {
    return { medianComputations: this.medianComputations, bookRevision: this.bookRevision,
      sortedPriceComputations: this.sortedPriceComputations,
      bestPriceFullScans: this.bestPriceFullScans };
  }

  private newlyAppearedDensities: DensityItem[] = [];

  public pollNewlyAppearedDensities(): DensityItem[] {
    const visible = new Map(this.getDensities().map((d) => [d.id, d]));
    const ids = new Set(this.newlyAppearedDensities.map(d => d.id));
    const items = Array.from(ids).flatMap(id => visible.has(id) ? [visible.get(id)!] : []);
    this.newlyAppearedDensities = [];
    return items;
  }

  private evaluateDensities() {
    const now = Date.now();
    const mid = (this.bestBid + this.bestAsk) / 2 || this.bestBid || this.bestAsk || 1;
    const threshold = this.calculateAdaptiveThreshold();
    const seen = new Set<string>();

    // Track the book edges during the existing density pass instead of
    // allocating spread arguments for two additional full-book scans.
    let minBidInBook = Infinity;
    let maxAskInBook = 0;
    const scan = (book: Map<number, number>, side: 'BID'|'ASK') => {
      for (const [price, qty] of book.entries()) {
        if (side === 'BID') minBidInBook = Math.min(minBidInBook, price);
        else maxAskInBook = Math.max(maxAskInBook, price);
        const notional = price * qty;
        if (notional < threshold) continue;
        const id = `${side.toLowerCase()}_${price}`;
        seen.add(id);
        const dist = Math.abs((price-mid)/mid)*100;
        this.updateOrAddDensity(id, side, price, qty, notional, dist, now);
      }
    };
    scan(this.bids,'BID'); scan(this.asks,'ASK');
    if (!this.bids.size) minBidInBook = 0;
    if (!this.asks.size) maxAskInBook = Infinity;

    for (const [id, item] of this.activeDensities.entries()) {
      if (seen.has(id)) continue;

      // #10 & #12: Check if order simply stepped out of visible top-20 window
      const isOutsideVisibleWindow = (item.side === 'BID' && item.price < minBidInBook) ||
                                     (item.side === 'ASK' && item.price > maxAskInBook);

      if (isOutsideVisibleWindow) {
        // Missing outside the snapshot is unknown, not a cancellation or continuous persistence.
        this.activeDensities.delete(id);
        this.densityStats.delete(id);
        continue;
      }

      const stats = this.densityStats.get(id);
      if (stats) stats.cancellations += 1;
      const age = Math.max(0.1, (now-item.firstSeenAt)/1000);
      const disappearedNearPrice = item.distancePct <= 0.25;
      const cancellationRate = stats ? stats.cancellations / Math.max(1, stats.samples) : 1;
      item.cancellationRate = Number(cancellationRate.toFixed(3));
      if (disappearedNearPrice && age < 60 && cancellationRate > 0.15) item.classification='POSSIBLE_SPOOF';
      else if (age < this.config.minPersistenceSeconds) item.classification='TRANSIENT_LIQUIDITY';
      item.qualityScore = this.calculateQuality(item, stats);
      this.densityHistory.unshift(item);
      if (this.densityHistory.length > 100) this.densityHistory.pop();
      this.activeDensities.delete(id);
      this.densityStats.delete(id);
    }
  }

  private updateOrAddDensity(id:string, side:'BID'|'ASK', price:number, qty:number, notional:number, distPct:number, now:number) {
    let stats = this.densityStats.get(id);
    const isBrandNew = !stats;
    if (!stats) {
      stats = { firstSeenAt:now,lastSeenAt:now,samples:0,presentSamples:0,sizeSumUsd:0,maxSizeUsd:notional,lastSizeUsd:notional,lastSizeChangeAt:now,cancellations:0,replenishments:0,nearestApproachPct:distPct };
      this.densityStats.set(id,stats);
    }
    stats.samples += 1; stats.presentSamples += 1; stats.lastSeenAt=now; stats.sizeSumUsd += notional;
    stats.maxSizeUsd=Math.max(stats.maxSizeUsd,notional); stats.nearestApproachPct=Math.min(stats.nearestApproachPct,distPct);
    if (notional > stats.lastSizeUsd * 1.05 && stats.lastSizeUsd > 0) stats.replenishments += 1;
    if (Math.abs(notional-stats.lastSizeUsd)/Math.max(stats.lastSizeUsd,1) > 0.1) stats.lastSizeChangeAt=now;
    stats.lastSizeUsd=notional;

    const existing=this.activeDensities.get(id);
    if(existing){
      existing.quantity=qty; existing.notionalUsd=notional; existing.distancePct=Number(distPct.toFixed(3)); existing.lastSeenAt=now;
      existing.ageSeconds=Math.floor((now-existing.firstSeenAt)/1000); existing.maxSizeUsd=Math.max(existing.maxSizeUsd,notional);
      existing.averageSizeUsd=stats.sizeSumUsd/Math.max(1,stats.presentSamples); existing.persistenceRatio=stats.presentSamples/Math.max(1,stats.samples);
      existing.persistenceSamples=stats.presentSamples; existing.cancellationRate=stats.cancellations/Math.max(1,stats.samples);
      existing.replenishmentRate=stats.replenishments/Math.max(1,stats.samples); existing.lastSizeChangeAt=stats.lastSizeChangeAt;
      if(existing.ageSeconds>=this.config.minPersistenceSeconds && existing.persistenceRatio>=0.65) existing.classification='PERSISTENT_LIQUIDITY';
      existing.qualityScore=this.calculateQuality(existing,stats);
    } else {
      const item:DensityItem={id,price,side,quantity:qty,notionalUsd:notional,distancePct:Number(distPct.toFixed(3)),firstSeenAt:now,lastSeenAt:now,ageSeconds:0,maxSizeUsd:notional,averageSizeUsd:notional,persistenceRatio:1,classification:'STANDARD',persistenceSamples:1,cancellationRate:0,replenishmentRate:0,qualityScore:20,lastSizeChangeAt:now};
      this.activeDensities.set(id,item);
      if (isBrandNew) {
        this.newlyAppearedDensities.push(item);
      }
    }
  }

  private calculateQuality(item:DensityItem, stats?:DensityStats):number {
    if (!stats) return item.qualityScore || 0;
    const persistence = Math.min(25, (item.persistenceRatio || 0) * 25);
    const duration = Math.min(20, (item.ageSeconds / Math.max(1,this.config.minPersistenceSeconds)) * 20);
    const sizeStability = Math.min(15, item.averageSizeUsd > 0 ? Math.min(1.5,item.notionalUsd/item.averageSizeUsd) * 10 : 0);
    const maxDistance = Math.max(this.config.minDistancePct, 0.6);
    const proximity = item.distancePct <= this.config.minDistancePct ? 15 : Math.max(0, 15 * (1 - Math.min(1, item.distancePct / maxDistance)));
    const replenishment = Math.min(15, (item.replenishmentRate || 0) * 60);
    const spoofPenalty = item.classification === 'POSSIBLE_SPOOF' ? 40 : Math.min(20,(item.cancellationRate||0)*50);
    return Math.max(0,Math.min(100,Math.round(persistence+duration+sizeStability+proximity+replenishment-spoofPenalty)));
  }

  public getOrderBookImbalance(levels=20):number {
    if (!this.dataValid || !this.hasFreshData()) return 0;
    const bids=this.getSortedBids(levels).reduce((s,l)=>s+l.notionalUsd,0);
    const asks=this.getSortedAsks(levels).reduce((s,l)=>s+l.notionalUsd,0);
    if(bids+asks===0)return 0;
    return (bids-asks)/(bids+asks);
  }

  public getDensityQualityAtPrice(side:'BID'|'ASK', price:number, maxDistancePct=0.6):DensityItem|undefined {
    return this.getDensities().filter(d=>d.side===side && d.classification!=='POSSIBLE_SPOOF' && Math.abs(d.price-price)/Math.max(price,1e-12)*100<=maxDistancePct).sort((a,b)=>(b.qualityScore||0)-(a.qualityScore||0))[0];
  }

  public getDensities(): DensityItem[] {
    if (!this.dataValid || !this.hasFreshData()) return [];
    const threshold = this.calculateAdaptiveThreshold();
    return Array.from(this.activeDensities.values())
      .filter(d => (d.side === 'BID' ? this.bids : this.asks).get(d.price) === d.quantity && d.notionalUsd >= threshold)
      .sort((a,b)=>b.notionalUsd-a.notionalUsd);
  }
  public getSignificantDensities(minNotional=500000):DensityItem[]{return this.getDensities().filter(d=>d.notionalUsd>=minNotional);}
  private hasFreshData(): boolean {
    return isFreshDepthTime(this.lastReceivedAt) && (!this.lastExchangeTimestamp || isFreshDepthTime(this.lastExchangeTimestamp));
  }
  public clear(){this.bookRevision++;this.thresholdMemo=null;this.sortedPricesMemo=null;this.bids.clear();this.asks.clear();this.activeDensities.clear();this.densityStats.clear();this.dataValid=false;this.sequenceGap=false;this.status='CONNECTING';this.lastUpdateId=0;this.lastReceivedAt=0;this.lastExchangeTimestamp=0;this.bestBid=0;this.bestAsk=0;this.newlyAppearedDensities=[];}
}
