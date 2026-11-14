import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  createCommunityHandoff, communityHandoffUrl, handoffQuery, HANDOFF_TF_SECONDS,
} from "../server/communityArchiveHandoff";

const routes = readFileSync(new URL("../server/pgIdentityRoutes.ts",import.meta.url),"utf8");
const modal = readFileSync(new URL("../src/components/ArchiveModal.tsx",import.meta.url),"utf8");
const now = Date.UTC(2026,10,14,13,20,0);
const step = HANDOFF_TF_SECONDS["1m"];
const capturedAt = now-60_000;
function archive(){
  return {
    id:"arch_test_btc",userId:"DO_NOT_SHARE_USER_123",symbol:"BTCUSDT",
    exchange:"binance",marketType:"futures",timeframe:"1m",savedAtTimestamp:capturedAt,
    entryPrice:101,stopLossPrice:96,targetPrice:109,necklinePrice:99,
    notes:"DO_NOT_SHARE_PRIVATE_NOTES",formation:{patternKey:"manual",confidence:0},
  };
}
function history(){
  const latest=Math.floor((capturedAt/1000-step)/step)*step;
  return Array.from({length:55},(_,i)=>{
    const time=latest-(54-i)*step;
    return {time,open:100,high:110,low:90,close:101,volume:1+i,privateField:"DONT_SHARE_SOURCE"};
  });
}

test("owner handoff includes exactly real, fully closed historical candles and whitelisted Entry/SL/TP",()=>{
  const q=handoffQuery(archive(),now);
  assert.equal(q.endTime,capturedAt);
  assert.deepEqual(q.scope,{symbol:"BTCUSDT",exchange:"binance",marketType:"futures",timeframe:"1m"});
  const packet=createCommunityHandoff(archive(),history(),now);
  assert.equal(packet.candles.length,55);
  assert.deepEqual(packet.candles[0],Object.values(history()[0]).slice(0,0).concat([
    history()[0].time,100,110,90,101,1,
  ]));
  assert.deepEqual(packet.markers.map(m=>m.type),["entry","stop_loss","target","neckline"]);
  assert.equal(packet.expiresAt-now,600_000);
  const destination=communityHandoffUrl(packet);
  assert.match(destination,/^https:\/\/community-stage\.h00k\.top\/#community\?section=feed&handoff=/);
  const token=destination.split("handoff=")[1];
  const unpacked=JSON.parse(Buffer.from(token,"base64url").toString("utf8"));
  assert.deepEqual(unpacked,packet);
  assert.doesNotMatch(JSON.stringify(unpacked),/DO_NOT_SHARE|userId|notes|privateField|password|apiKey/);
  assert.ok(token.length<24000);
});

test("handoff drops incomplete candles, never invents market history and never sends future prices",()=>{
  const valid=history();
  const inProgress={...valid.at(-1)!,time:Math.floor(capturedAt/1000)};
  const packet=createCommunityHandoff(archive(),[...valid,inProgress],now);
  assert.equal(packet.candles.length,55);
  assert.ok(packet.candles.every(([t])=>(t+step)*1000<=capturedAt));
  assert.throws(()=>createCommunityHandoff(archive(),[],now),/Недостатньо історичних свічок/);
  assert.throws(()=>createCommunityHandoff(archive(),history().slice(-5),now));
  assert.throws(()=>handoffQuery({...archive(),targetPrice:0},now));
  assert.throws(()=>handoffQuery({...archive(),savedAtTimestamp:now+120_000},now));
  assert.throws(()=>handoffQuery({...archive(),symbol:"BTC/USDT"},now));
});

test("only known Community targets are allowed; fragments contain no cookies",()=>{
  const packet=createCommunityHandoff(archive(),history(),now);
  assert.match(communityHandoffUrl(packet,"https://community.h00k.top"),/^https:\/\/community\.h00k\.top\//);
  assert.throws(()=>communityHandoffUrl(packet,"https://evil.example"),/не дозволений/);
  assert.throws(()=>communityHandoffUrl(packet,"http://community-stage.h00k.top"),/не дозволений/);
  assert.match(routes,/app\.get\('\/api\/account\/archive\/:id\/community-handoff', requirePostgresSession/);
  assert.match(routes,/rateLimit\(req, 'community-handoff', 4, 60_000, false\)/);
  assert.match(routes,/loadArchiveItem\(res\.locals\.userId, String\(req\.params\.id\)\)/);
  assert.match(routes,/fetchKlines\(/);
  assert.match(routes,/createCommunityHandoff\(archive, candles, Date\.now\(\), qualityProof\)/);
  assert.match(modal,/onClick=\{event => void handleSendToCommunity\(item\.id, event\)\}/);
  assert.match(modal,/window\.location\.assign\(destination\.href\)/);
  assert.doesNotMatch(routes,/community-handoff.*localStorage|community-handoff.*tokenCookie/);
});
