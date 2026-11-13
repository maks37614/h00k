import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { PoolClient } from 'pg';
import type { PriceAlert, AlertHistoryItem, SurveillanceCoin } from '../src/types';

type DbClient = Pick<PoolClient, 'query'>;
export type PersonalStateSnapshot = {
  surveillance: Record<string, SurveillanceCoin[]>;
  alerts: PriceAlert[];
  history: AlertHistoryItem[];
};
export type MigrationCount = { surveillance: number; alerts: number; history: number;
  orphaned: number; invalid: number };
export const STATE_MIGRATION_CHUNK = 100;

/** Preserve only identities registered in PostgreSQL. Legacy/guest account
 * records remain in the original JSON backup, never resurrected as monitors. */
export function preparePersonalStateRows(snapshot: PersonalStateSnapshot,
  knownUsers: ReadonlySet<string>) {
  const rows = {
    surveillance: [] as Array<{ owner: string; id: string; exchange: string; market: string;
      symbol: string; active: boolean; payload: SurveillanceCoin }>,
    alerts: [] as Array<{ owner: string; id: string; exchange: string; market: string;
      symbol: string; active: boolean; payload: PriceAlert }>,
    history: [] as Array<{ owner: string; id: string; time: number; payload: AlertHistoryItem }>,
  };
  let orphaned=0,invalid=0;
  const ownerAllowed=(userId: unknown): userId is string =>
    typeof userId === 'string' && userId !== 'guest' && knownUsers.has(userId);
  const marketValid=(x:any) =>
    (x?.exchange === 'binance' || x?.exchange === 'bybit') &&
    (x.marketType === 'spot' || x.marketType === 'futures') &&
    typeof x.symbol === 'string' && /^[A-Z0-9]{2,40}$/.test(x.symbol.toUpperCase());
  const identValid=(id:unknown) => typeof id === 'string' && id.length > 0 && id.length <= 256;
  for(const [user,coins] of Object.entries(snapshot.surveillance || {})) {
    if (!Array.isArray(coins)) { invalid++; continue; }
    for(const coin of coins) {
      if(!ownerAllowed(user) || coin?.userId!==user) { orphaned++; continue; }
      if(!identValid(coin?.id) || !marketValid(coin)) { invalid++; continue; }
      rows.surveillance.push({ owner:user,id:coin.id,exchange:coin.exchange,
        market:coin.marketType,symbol:coin.symbol.toUpperCase(),
        active:coin.isActive===true,payload:coin });
    }
  }
  for (const alert of snapshot.alerts || []) {
    if (!ownerAllowed(alert?.userId)) { orphaned++; continue; }
    if (!identValid(alert?.id) || !marketValid(alert)) { invalid++; continue; }
    rows.alerts.push({owner:alert.userId!,id:alert.id,exchange:alert.exchange,
      market:alert.marketType,symbol:alert.symbol.toUpperCase(),
      active:alert.isActive===true,payload:alert});
  }
  for (const event of snapshot.history || []) {
    if (!ownerAllowed(event?.userId)) { orphaned++; continue; }
    if (!identValid(event?.id) || !Number.isSafeInteger(event?.triggeredAt)) {
      invalid++; continue;
    }
    rows.history.push({owner:event.userId,id:event.id,time:event.triggeredAt,payload:event});
  }
  const unique=<T>(items: readonly T[], key:(item:T)=>string) =>
    [...new Map(items.map(item=>[key(item),item])).values()];
  return {
    surveillance:unique(rows.surveillance,x=>JSON.stringify([x.owner,x.id])),
    alerts:unique(rows.alerts,x=>JSON.stringify([x.owner,x.id])),
    history:unique(rows.history,x=>JSON.stringify([x.owner,x.id])),
    skipped:{ orphaned,invalid },
  };
}

async function batchInsert(client: DbClient, table: string,
  columns: readonly string[], rows: readonly (readonly unknown[])[]) {
  let inserted=0;
  for(let at=0;at<rows.length;at+=STATE_MIGRATION_CHUNK){
    const chunk=rows.slice(at,at+STATE_MIGRATION_CHUNK);
    const values: unknown[]=[];
    const tuples=chunk.map((row,i)=>{
      values.push(...row);
      return '('+row.map((_,j)=>'$'+(i*columns.length+j+1)).join(',')+')';
    });
    const conflict=table==='h00k_alert_history_state'?'history_id':
      table==='h00k_price_alert_state'?'alert_id':'coin_id';
    const updates=columns.filter(c=>c!=='user_id'&&c!==conflict)
      .map(c=>c+'=EXCLUDED.'+c).join(',');
    // Table and column names are fixed internal literals, never user input.
    const result=await client.query(
      'INSERT INTO '+table+' ('+columns.join(',')+') VALUES '+tuples.join(',')+
      ' ON CONFLICT (user_id,'+conflict+') DO UPDATE SET '+updates+' RETURNING 1',values);
    inserted+=result.rowCount || 0;
  }
  return inserted;
}

export async function stagePersonalStateToPostgres(client:DbClient,snapshot:PersonalStateSnapshot,
  schema:string) {
  await client.query('BEGIN');
  try {
    // A transaction-wide advisory lock prevents simultaneous migrations.
    await client.query('SELECT pg_advisory_xact_lock(811040027)');
    await client.query(schema);
    const users = await client.query('SELECT id FROM auth_users');
    const known=new Set<string>(users.rows.map((row:{id:string})=>row.id));
    const prepared=preparePersonalStateRows(snapshot,known);
    const surveillance=await batchInsert(client,'h00k_surveillance_state',
      ['user_id','coin_id','exchange','market_type','symbol','is_active','payload'],
      prepared.surveillance.map(r=>[r.owner,r.id,r.exchange,r.market,r.symbol,r.active,
        JSON.stringify(r.payload)]));
    const alerts=await batchInsert(client,'h00k_price_alert_state',
      ['user_id','alert_id','exchange','market_type','symbol','is_active','payload'],
      prepared.alerts.map(r=>[r.owner,r.id,r.exchange,r.market,r.symbol,r.active,
        JSON.stringify(r.payload)]));
    const history=await batchInsert(client,'h00k_alert_history_state',
      ['user_id','history_id','triggered_at','payload'],
      prepared.history.map(r=>[r.owner,r.id,r.time,JSON.stringify(r.payload)]));
    if (surveillance!==prepared.surveillance.length || alerts!==prepared.alerts.length ||
      history!==prepared.history.length) throw new Error('PostgreSQL batch verification mismatch');
    await client.query('COMMIT');
    return {surveillance,alerts,history,...prepared.skipped};
  } catch(e) { await client.query('ROLLBACK');throw e; }
}
export const readPersonalStateSchema=()=>readFileSync(new URL('./migrations/002_personal_state.sql',
  import.meta.url),'utf8');
export function readJsonSnapshot(dataDir=resolve(process.cwd(),'server','data')):
  PersonalStateSnapshot {
  const read=(name:string,empty:unknown)=> {
    try { return JSON.parse(readFileSync(resolve(dataDir,name),'utf8')); }
    catch(e) {
      if ((e as NodeJS.ErrnoException)?.code === 'ENOENT') return empty;
      throw e;
    }
  };
  return { surveillance:read('surveillance.json',{}) as PersonalStateSnapshot['surveillance'],
    alerts:read('alerts.json',[]) as PriceAlert[],
    history:read('alert_history.json',[]) as AlertHistoryItem[] };
}
