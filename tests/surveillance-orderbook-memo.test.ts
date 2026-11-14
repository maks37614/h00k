import test from 'node:test';
import assert from 'node:assert/strict';
import { OrderBookEngine } from '../server/surveillance/orderBookEngine';

test('repeated snapshots and density reads reuse the same book median',()=>{
 const book=new OrderBookEngine('BTCUSDT','binance','futures');
 book.applyDepth({sequence:1,isSnapshot:true,bids:[[100,100],[99,10]],
    asks:[[101,20],[102,1]],eventTime:Date.now()});
 const computed=book.thresholdStats().medianComputations;
 assert.equal(computed,1,'first depth evaluation calculates a median');
 for(let i=0;i<30;i++){
   book.getDensities(); book.calculateAdaptiveThreshold();
 }
 assert.equal(book.thresholdStats().medianComputations,computed);
 book.applyDepth({sequence:2,bids:[[98,25]],asks:[],eventTime:Date.now()});
 assert.equal(book.thresholdStats().medianComputations,computed+1);
});
test('manual and HYBRID settings, 24h turnover changes and resync invalidate cache correctly',()=>{
 const book=new OrderBookEngine('BTCUSDT','bybit','futures');
 book.applyDepth({sequence:1,isSnapshot:true,bids:[[100,50],[99,1]],
    asks:[[101,2]],eventTime:Date.now()});
 const prev=book.calculateAdaptiveThreshold();
 book.updateConfig({mode:'MANUAL',manualThresholdUsd:2000});
 assert.equal(book.calculateAdaptiveThreshold(),2000);
 book.updateConfig({mode:'AUTO'});
 assert.equal(book.calculateAdaptiveThreshold(),prev);
 book.setVolume24hUsd(900_000_000);
 assert.equal(book.calculateAdaptiveThreshold(),90_000);
 book.updateConfig({mode:'HYBRID',manualThresholdUsd:110_000});
 assert.equal(book.calculateAdaptiveThreshold(),110_000);
 book.setStatus('RESYNCING');
 book.applyDepth({sequence:2,isSnapshot:true,bids:[[100,50]],asks:[[101,2]],eventTime:Date.now()});
 assert.equal(book.getState().status,'LIVE');
 assert.equal(book.calculateAdaptiveThreshold(),110_000);
});

test('top-of-book and imbalance share sorting until next depth revision',()=>{
 const book=new OrderBookEngine('BTCUSDT','binance','futures');
 book.applyDepth({sequence:1,isSnapshot:true,bids:[[99,2],[100,5],[98,3]],
   asks:[[103,1],[101,2],[102,2]],eventTime:Date.now()});
 const initial=book.thresholdStats().sortedPriceComputations;
 assert.equal(initial,0,'density evaluation does not request sorted price arrays');
 const state=book.getState();
 assert.deepEqual(state.bids.map(x=>x.price),[100,99,98]);
 assert.deepEqual(state.asks.map(x=>x.price),[101,102,103]);
 assert.equal(book.thresholdStats().sortedPriceComputations,initial+2);
 const expectedImbalance=book.getOrderBookImbalance(2);
 for(let i=0;i<30;i++){
   assert.equal(book.getOrderBookImbalance(2),expectedImbalance);
   assert.equal(book.getState().bids[0].price,100);
   book.getSortedAsks(1);
 }
 assert.equal(book.thresholdStats().sortedPriceComputations,initial+2,
   'repeated snapshots and imbalance reads must reuse both sorted-price lists');
 state.bids[0].price=1;
 state.bids[0].quantity=999999;
 assert.deepEqual(book.getSortedBids(1).map(x=>[x.price,x.quantity]),[[100,5]],
   'snapshots are copies; mutating one cannot poison the sorted cache');
 book.applyDepth({sequence:2,bids:[[99,0],[104,10]],asks:[],eventTime:Date.now()});
 assert.deepEqual(book.getSortedBids(3).map(x=>x.price),[104,100,98]);
 assert.equal(book.thresholdStats().sortedPriceComputations,initial+3);
 assert.deepEqual(book.getSortedAsks(2).map(x=>x.price),[101,102]);
 assert.equal(book.thresholdStats().sortedPriceComputations,initial+4);
 book.clear();
 assert.deepEqual(book.getSortedBids(),[]);
 assert.deepEqual(book.getSortedAsks(),[]);
 assert.equal(book.thresholdStats().sortedPriceComputations,initial+6,
   'clearing a book releases the cached ordering and invalidates both sides');
});
