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
