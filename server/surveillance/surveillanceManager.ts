import { SurveillanceCoin } from '../../src/types';
import { CoinWorker, CoinWorkerSnapshot } from './coinWorker';
import { MacroAndNewsEngine } from './macroAndNewsEngine';
import { StateMachineAndAlerts } from './stateMachineAndAlerts';
import { loadSurveillanceStore } from '../surveillanceService';
import { assertActiveMarketAccount } from '../deletedAccounts';

export class SurveillanceManager {
  private static instance: SurveillanceManager | null = null;

  private workers = new Map<string, CoinWorker>();
  private workerKey(coinId: string, userId: string) { return JSON.stringify([userId, coinId]); }
  public readonly macroEngine = new MacroAndNewsEngine();
  public readonly alertManager = new StateMachineAndAlerts();

  private isStarted = false;

  public static getInstance(): SurveillanceManager {
    if (!SurveillanceManager.instance) {
      SurveillanceManager.instance = new SurveillanceManager();
    }
    return SurveillanceManager.instance;
  }

  constructor() {}

  public start() {
    if (this.isStarted) return;
    this.isStarted = true;
    console.log('[SurveillanceManager] 🛰 Starting 24/7 Surveillance Engine...');

    // Boot up active workers for all persisted coins
    try {
      const store = loadSurveillanceStore();
      let activeCount = 0;
      for (const [userId, coins] of Object.entries(store)) {
        if (Array.isArray(coins)) {
          for (const coin of coins) {
            if (userId !== 'guest' && coin.isActive) {
              this.startWorkerForCoin(coin);
              activeCount++;
            }
          }
        }
      }
      console.log(`[SurveillanceManager] Successfully initialized ${activeCount} active 24/7 surveillance workers.`);
    } catch (e) {
      console.error('[SurveillanceManager] Error booting workers:', e);
    }
  }

  public startWorkerForCoin(coin: SurveillanceCoin): CoinWorker {
    assertActiveMarketAccount(coin.userId);
    const existing = this.workers.get(this.workerKey(coin.id, coin.userId));
    if (existing) {
      existing.updateCoin(coin);
      return existing;
    }

    console.log(`[SurveillanceManager] Spawning 24/7 worker for #${coin.symbol} (${coin.exchange.toUpperCase()} ${coin.marketType})`);
    const worker = new CoinWorker(coin, this.macroEngine, this.alertManager);
    this.workers.set(this.workerKey(coin.id, coin.userId), worker);
    return worker;
  }

  public updateWorkerCoin(coin: SurveillanceCoin) {
    const worker = this.workers.get(this.workerKey(coin.id, coin.userId));
    if (worker) {
      worker.updateCoin(coin);
    }
  }

  public stopWorkerForCoin(coinId: string, userId: string): boolean {
    const worker = this.workers.get(this.workerKey(coinId, userId));
    if (worker) {
      console.log(`[SurveillanceManager] Stopping worker for ${worker.coin.symbol}`);
      worker.destroy();
      this.workers.delete(this.workerKey(coinId, userId));
      return true;
    }
    return false;
  }

  public getWorker(coinId: string, userId: string): CoinWorker | undefined {
    return this.workers.get(this.workerKey(coinId, userId));
  }

  public getWorkerSnapshot(coinId: string, userId: string): CoinWorkerSnapshot | null {
    const worker = this.workers.get(this.workerKey(coinId, userId));
    return worker ? worker.getSnapshot() : null;
  }

  public getAllSnapshots(userId?: string): CoinWorkerSnapshot[] {
    const snapshots: CoinWorkerSnapshot[] = [];
    for (const worker of this.workers.values()) {
      if (!userId || worker.coin.userId === userId) {
        snapshots.push(worker.getSnapshot());
      }
    }
    return snapshots;
  }

  public getActiveWorkerCount(): number {
    return this.workers.size;
  }
  public stopWorkersForUser(userId:string){
    for(const worker of [...this.workers.values()])if(worker.coin.userId===userId)this.stopWorkerForCoin(worker.coin.id,userId);
  }
}

export const surveillanceManager = SurveillanceManager.getInstance();
