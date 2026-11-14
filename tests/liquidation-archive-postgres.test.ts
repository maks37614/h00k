import assert from 'node:assert/strict';
import {test} from 'node:test';
import {randomUUID} from 'node:crypto';
import {Pool} from 'pg';
import {LiquidationArchive} from '../server/liquidationArchive';

/** Integration test runs only when the GitHub CI PostgreSQL service is present.
 * Never connects to a user's production database by default.
 */
test('PostgreSQL 16 Liq archive deduplicates reconnects and cumulative Binance fills', {
  skip: process.env.LIQ_TEST_PG !== '1',
}, async () => {
  const pool = new Pool({
    host: process.env.PGHOST,
    user: process.env.PGUSER,
    password: process.env.PGPASSWORD,
    database: process.env.PGDATABASE,
    max: 1,
  });
  const archive = new LiquidationArchive(true,100,()=>pool);
  const id = 'test:' + randomUUID();
  const row = {
    exchange:'binance' as const,symbol:'BTCUSDT',
    id,t:Date.now(),side:'LONG' as const,p:67234.5,q:0.02,usd:1344.69,
  };
  try {
    archive.record(row);
    await archive.flush();
    archive.record(row);
    await archive.flush();
    archive.record({...row,q:0.05,usd:3361.725});
    await archive.flush();
    archive.record({...row,q:0.01,usd:672.345});
    await archive.flush();
    const records=await pool.query(
      'SELECT observed_notional, quantity, side FROM h00k_liquidation_events WHERE exchange=$1 AND symbol=$2 AND event_id=$3',
      ['binance','BTCUSDT',id],
    );
    assert.equal(records.rows.length,1);
    assert.equal(Number(records.rows[0].observed_notional),3361.725);
    assert.equal(Number(records.rows[0].quantity),0.05);
    const heatmap=await archive.heatmap('binance','BTCUSDT',24);
    assert.equal(heatmap?.source,'observed_liquidations');
    assert.ok(heatmap!.bins.some(bin=>bin.usd>=3361.725 && bin.side==='LONG'));
  } finally {
    await pool.query('DELETE FROM h00k_liquidation_events WHERE event_id=$1',[id]).catch(()=>{});
    await pool.end();
  }
});
