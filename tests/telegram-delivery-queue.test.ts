import test from 'node:test';
import assert from 'node:assert/strict';
import { TelegramDispatchQueue } from '../server/telegramQueue';
import { readFileSync } from 'node:fs';

test('Telegram queue serializes parallel sends, limiting bot and per-chat bursts', async () => {
  let clock = 1000;
  const calls: Array<{key:string;at:number}> = [];
  const queue = new TelegramDispatchQueue(
    () => clock, async ms => { clock += ms; }, 120, 1100,
  );
  const send = (key:string) => queue.schedule('same-bot',key,async()=>{
    calls.push({key,at:clock});return true;
  });
  await Promise.all([send('alice'),send('bob'),send('alice')]);
  assert.deepEqual(calls.map(x=>x.key),['alice','bob','alice']);
  assert.ok(calls[1].at - calls[0].at >= 120);
  assert.ok(calls[2].at - calls[0].at >= 1100);
  assert.equal(queue.stats().queued,0);
});
test('failed Telegram sends release queue slot so other users are never blocked',async()=>{
  const queue = new TelegramDispatchQueue(()=>10000,async()=>{},0,0);
  const calls:string[]=[];
  const first=queue.schedule('bot','a',async()=>{calls.push('a');throw Error('denied');}).catch(()=>false);
  const second=queue.schedule('bot','b',async()=>{calls.push('b');return true;});
  assert.equal(await first,false);
  assert.equal(await second,true);
  assert.deepEqual(calls,['a','b']);
  assert.equal(queue.stats().queued,0);
});
test('persistent retries and direct sends use the same paced queue',()=>{
  const file=readFileSync(new URL('../server/telegramDelivery.ts',import.meta.url),'utf8');
  assert.match(file,/telegramDispatchQueue\.schedule\(record\.botId, record\.chatId/);
  assert.match(file,/messageIds\.push\(\.\.\.result\.messageIds\)/);
  assert.match(file,/startTelegramDeliveryWorker/);
});
