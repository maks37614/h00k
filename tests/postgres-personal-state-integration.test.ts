import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { Pool } from 'pg';
import { stagePersonalStateToPostgres } from '../server/pgPersonalState';

test('PostgreSQL 16 staging is idempotent, indexed and excludes former user IDs', async t => {
  if(process.env.H00K_PG_INTEGRATION_TEST !== '1') {
    t.skip('integration database is not provided');
    return;
  }
  const pool=new Pool({max:2,connectionTimeoutMillis:4000});
  const owner='stage-'+randomUUID();
  const unknown='orphan-'+randomUUID();
  const client=await pool.connect();
  const schema=readFileSync(new URL('../server/migrations/002_personal_state.sql',import.meta.url),'utf8');
  const identitySchema=readFileSync(new URL('../server/migrations/001_identity.sql',import.meta.url),'utf8');
  try {
    await client.query(identitySchema);
    await client.query('INSERT INTO auth_users (id,email,password_hash,display_name) VALUES ($1,$2,$3,$4)',
      [owner,owner+'@example.test','test-only-hash','Migration test']);
    const snapshots={
      surveillance:{[owner]:[{
        id:'coin-1',userId:owner,exchange:'binance',marketType:'futures',symbol:'BTCUSDT',
        isActive:true,config:{triggerModes:['bar_close']},state:{currentPrice:100}
      }],[unknown]:[{
        id:'skip-1',userId:unknown,exchange:'bybit',marketType:'spot',symbol:'BTCUSDT',
        isActive:true,config:{triggerModes:['bar_close']}
      }]},
      alerts:[{id:'alert-1',userId:owner,exchange:'binance',marketType:'futures',
        symbol:'BTCUSDT',targetPrice:100,condition:'gte',isActive:true,triggered:false,
        createdAt:Date.now()}],
      history:[{id:'history-1',userId:owner,triggeredAt:Date.now(),symbol:'BTCUSDT',
        exchange:'binance',marketType:'futures',condition:'gte',targetPrice:100,
        triggeredPrice:105,telegramSent:false}],
    };
    const counts=await stagePersonalStateToPostgres(client,snapshots as any,schema,{stageKey:owner});
    assert.deepEqual([counts.surveillance,counts.alerts,counts.history,counts.orphaned],
      [1,1,1,1]);
    await stagePersonalStateToPostgres(client,snapshots as any,schema,{stageKey:owner});
    const results=await Promise.all([
      client.query('SELECT user_id,coin_id,exchange,market_type,symbol,payload FROM h00k_surveillance_state WHERE user_id=$1',[owner]),
      client.query('SELECT count(*)::int AS count FROM h00k_price_alert_state WHERE user_id=$1',[owner]),
      client.query('SELECT count(*)::int AS count FROM h00k_alert_history_state WHERE user_id=$1',[owner]),
      client.query('SELECT count(*)::int AS count FROM h00k_surveillance_state WHERE user_id=$1',[unknown]),
    ]);
    assert.equal(results[0].rows.length,1);
    assert.equal(results[0].rows[0].payload.state.currentPrice,100);
    assert.equal(results[1].rows[0].count,1);
    assert.equal(results[2].rows[0].count,1);
    assert.equal(results[3].rows[0].count,0);
    const indices=await client.query(
      "SELECT indexname FROM pg_indexes WHERE tablename IN ('h00k_surveillance_state','h00k_price_alert_state','h00k_alert_history_state')");
    assert.ok(indices.rows.some((r:{indexname:string})=>r.indexname==='h00k_surveillance_active_market_idx'));
    assert.ok(indices.rows.some((r:{indexname:string})=>r.indexname==='h00k_alert_history_recent_idx'));

    // A re-staging of unchanged JSON MUST NOT overwrite a PostgreSQL edit
    // committed after the first migration (such as an alert being paused).
    await client.query(
      'UPDATE h00k_price_alert_state SET is_active=false WHERE user_id=$1 AND alert_id=$2',
      [owner,'alert-1']);
    await assert.rejects(
      () => stagePersonalStateToPostgres(client,snapshots as any,schema,{stageKey:owner}),
      /PostgreSQL staging conflict/,
    );
    const newer=await client.query(
      'SELECT is_active FROM h00k_price_alert_state WHERE user_id=$1 AND alert_id=$2',
      [owner,'alert-1']);
    assert.equal(newer.rows[0].is_active,false,
      'the failed replay must roll back, preserving newer PostgreSQL state');

    // The source fingerprint prevents an updated or older JSON snapshot
    // from silently reintroducing deleted/modified records under the same run.
    await client.query(
      'UPDATE h00k_price_alert_state SET is_active=true WHERE user_id=$1 AND alert_id=$2',
      [owner,'alert-1']);
    const changedSnapshot=structuredClone(snapshots);
    changedSnapshot.alerts[0].targetPrice=101;
    await assert.rejects(
      () => stagePersonalStateToPostgres(client,changedSnapshot as any,schema,{stageKey:owner}),
      /staging source has changed/,
    );
    const persisted=await client.query(
      'SELECT payload FROM h00k_price_alert_state WHERE user_id=$1 AND alert_id=$2',
      [owner,'alert-1']);
    assert.equal(persisted.rows[0].payload.targetPrice,100,
      'a changed source must not overwrite staged history or alerts');
    const marker=await client.query(
      'SELECT snapshot_sha256 FROM h00k_personal_state_staging_runs WHERE stage_key=$1',
      [owner]);
    assert.equal(marker.rows[0].snapshot_sha256,counts.snapshotSha256);
  } finally {
    await client.query('DELETE FROM h00k_personal_state_staging_runs WHERE stage_key=$1',[owner]).catch(()=>{});
    await client.query('DELETE FROM h00k_alert_history_state WHERE user_id=$1',[owner]).catch(()=>{});
    await client.query('DELETE FROM h00k_price_alert_state WHERE user_id=$1',[owner]).catch(()=>{});
    await client.query('DELETE FROM h00k_surveillance_state WHERE user_id=$1',[owner]).catch(()=>{});
    await client.query('DELETE FROM auth_users WHERE id=$1',[owner]).catch(()=>{});
    client.release();
    await pool.end();
  }
});
