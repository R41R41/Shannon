'use strict';
// New empty, isolated MongoDB only; no shared env, ordinary DB, LINE or model API.
const assert = require('node:assert/strict'); const fs = require('node:fs'); const path = require('node:path');
const { spawn } = require('node:child_process'); const { pathToFileURL } = require('node:url'); const net = require('node:net');
const root = path.resolve(__dirname, '..');
async function main() {
  assert.equal(root, '/home/azureuser/Shannon-dev'); assert.equal(process.argv[2], '--isolated-fixture'); assert.equal(process.argv.length, 3);
  assert(fs.existsSync(path.join(root, '.dev-runtime-lock')));
  await new Promise((resolve, reject) => { const probe = net.createServer(); probe.once('error', reject); probe.listen(37030, '127.0.0.1', () => probe.close(resolve)); });
  const out = '/home/azureuser/.codex-shannon-preservation/line2-20260829'; fs.mkdirSync(out, { recursive: true, mode: 0o700 });
  const data = fs.mkdtempSync(path.join(out, 'mongo-')); fs.chmodSync(data, 0o700);
  const child = spawn('mongod', ['--dbpath', data, '--bind_ip', '127.0.0.1', '--port', '37030', '--journal', '--logpath', path.join(data, 'mongod.log')], { stdio: 'ignore' });
  const exited = new Promise((resolve, reject) => { child.once('exit', (code, signal) => resolve({ code, signal })); child.once('error', reject); });
  const { mongo } = require('mongoose'); let client; const uri = 'mongodb://127.0.0.1:37030'; let result;
  try {
    for (let i = 0; i < 50; i++) {
      client = new mongo.MongoClient(uri, { serverSelectionTimeoutMS: 100, socketTimeoutMS: 5000 });
      try { await client.connect(); break; } catch (e) { await client.close(); client = undefined; if (i === 49) throw e; }
      await new Promise(r => setTimeout(r, 100));
    }
    const load = f => import(pathToFileURL(path.join(root, 'backend/dist/services/line', f)).href);
    const { MongoLineLedger, LINE_LEDGER_COLLECTION } = await load('mongoLedger.js'); const { LineLedger } = await load('ledger.js'); const { lineConfig } = await load('config.js');
    const bot = 'U' + 'a'.repeat(32), owner = 'U' + 'b'.repeat(32), other = 'U' + 'c'.repeat(32);
    const now = Date.parse('2026-08-29T03:00:00Z');
    const config = lineConfig({ LINE_ENABLED: 'true', LINE_BOT_USER_ID: bot, LINE_PERSONAL_USER_ID: owner, LINE_CHANNEL_SECRET: 'a'.repeat(32),
      LINE_CHANNEL_ACCESS_TOKEN: 'a'.repeat(64), LINE_CHAT_MAX_PER_24H: '1', LINE_PUSH_MAX_PER_24H: '1', LINE_PUSH_MAX_PER_MONTH: '1' });
    const db = client.db('line_fixture'); const repository = new MongoLineLedger(db); const ledger = new LineLedger(repository, config, () => now);
    const reservations = await Promise.all(Array.from({ length: 8 }, (_, i) => ledger.reserveChat('event' + i, 'group:fixture')));
    assert.equal(reservations.filter(Boolean).length, 1);
    await ledger.consent('on', now, true);
    const digest = { id: 'digest', ownerUserId: owner, text: '架空情報 https://example.com/', expiresAt: now + 3600000 };
    const enqueued = await Promise.all(Array.from({ length: 8 }, () => ledger.enqueue(digest)));
    const id = enqueued.find(Boolean); assert.equal(enqueued.filter(Boolean).length, 1);
    // Close and reopen the application DB client; Mongo remains running until the final stop.
    await client.close(); client = new mongo.MongoClient(uri); await client.connect();
    const restored = new LineLedger(new MongoLineLedger(client.db('line_fixture')), config, () => now);
    assert.equal((await restored.read()).entries.filter(e => e.kind === 'push').length, 1);
    assert.equal(await restored.enqueue({ ...digest, id: 'second' }), undefined);
    const claims = await Promise.all(Array.from({ length: 8 }, () => restored.claim(id))); assert.equal(claims.filter(Boolean).length, 1);
    await restored.finish(id, { status: 'accepted', messageId: '123' }); assert.equal(await restored.quote('123'), digest.text);
    await restored.consent('off', now + 1, false); assert.equal(await restored.quote('123'), undefined);
    assert(!JSON.stringify(await restored.read()).includes('架空情報'));
    await assert.rejects(() => new LineLedger(new MongoLineLedger(client.db('line_fixture')), { ...config, personalUserId: other }, () => now).read(), /LINE_BINDING_CHANGED/);
    assert.equal(await client.db('line_fixture').collection(LINE_LEDGER_COLLECTION).countDocuments(), 1);
    const radarLoad = f => import(pathToFileURL(path.join(root, 'backend/dist/services/radar', f)).href);
    const { MongoPersonalCatalog } = await radarLoad('mongoPersonalCatalog.js');
    const { CATALOG_VALIDATOR } = await import(pathToFileURL(path.join(root,'backend/dist/modules/radar/catalogVersion.js')).href);
    const { LineRadarWorker } = await load('radarWorker.js'); const { createLineApplication } = await load('application.js');
    const { parseFeed } = await radarLoad('feedConnector.js');
    const { PersonalTemporalReaders } = await radarLoad('personalTemporalReaders.js');
    const radarDb = client.db('line_radar_fixture');
    await radarDb.createCollection('radarpersonalcatalogs', { validator: CATALOG_VALIDATOR, validationLevel: 'strict', validationAction: 'error' });
    let reads = 0, sends = 0, clock = now, pendingOnly = true;
    const policy = { version: 1, enabled: true, hourJst: 12, minuteJst: 0, consentExpiresAt: now+7*86400000, weather: null,
      feeds: [{id:'news',kind:'web',locator:'https://example.com/feed.xml',articleHosts:['example.com'],topicIds:['science'],maxItems:10,retentionMs:7*86400000}] };
    const compose = db => {
      const runtime = createLineApplication(config,{state:new MongoLineLedger(db),chat:{reply:async()=>{throw Error();}},
        transport:{reply:async()=>{throw Error();},push:async()=>{sends++;return {status:'accepted',messageId:'9999'};}}},()=>clock);
      const ports = {ledger:runtime.ledger,catalog:new MongoPersonalCatalog(db),readPolicy:async()=>policy,temporal:new PersonalTemporalReaders(),
        feed:{read:async source=>{reads++;return parseFeed(`<rss><channel><item><title>Fixture science</title><link>https://example.com/article</link><guid>one</guid><pubDate>${new Date(now-3600000).toUTCString()}</pubDate></item></channel></rss>`,source,clock);}},
        deliver:async(...args)=>pendingOnly?'deferred':runtime.deliver(...args)};
      return {runtime,worker:()=>new LineRadarWorker(config,ports,()=>clock)};
    };
    let composition=compose(radarDb); await composition.runtime.ledger.consent('on',clock,true);
    const scheduled=await Promise.all(Array.from({length:8},()=>composition.worker().tick()));
    assert.equal(scheduled.filter(s=>s==='deferred').length,1);assert.equal(reads,1);assert.equal(sends,0);
    assert.equal((await composition.runtime.ledger.read()).entries.filter(e=>e.kind==='push'&&e.status==='pending').length,1);
    composition.runtime.stop(); await client.close(); client=new mongo.MongoClient(uri); await client.connect();
    pendingOnly=false; composition=compose(client.db('line_radar_fixture'));
    await Promise.all(Array.from({length:8},()=>composition.worker().tick()));
    assert.equal(sends,1);assert.equal(reads,1);
    clock+=3600000; const worker=composition.worker();
    assert((await composition.runtime.ledger.quote('9999',worker.authorizeQuote)).includes('Fixture science'));
    await composition.runtime.ledger.consent('off',clock,false);
    assert(!JSON.stringify(await composition.runtime.ledger.read()).includes('Fixture science'));
    composition.runtime.stop();
    const runtimeDb=client.db('line_runtime_fixture');
    await runtimeDb.createCollection('radarpersonalcatalogs',{validator:CATALOG_VALIDATOR,validationLevel:'strict',validationAction:'error'});
    const {openLineRuntime}=await import(pathToFileURL(path.join(root,'backend/dist-line/runtime.mjs')).href);
    const isolated=await openLineRuntime({env:{LINE_ENABLED:'true',LINE_BOT_USER_ID:bot,LINE_PERSONAL_USER_ID:owner,
      LINE_CHANNEL_SECRET:'a'.repeat(32),LINE_CHANNEL_ACCESS_TOKEN:'a'.repeat(64)},db:runtimeDb,
      readPolicy:async()=>({version:1,enabled:false,hourJst:12,minuteJst:0,consentExpiresAt:0,feeds:[],weather:null}),
      profile:'Fixture only',port:15040,closeResources:async()=>{}});
    try {
      assert.equal((await fetch('http://127.0.0.1:15040/healthz')).status,200);
      const body=JSON.stringify({destination:bot,events:[]});
      const signature=require('node:crypto').createHmac('sha256','a'.repeat(32)).update(body).digest('base64');
      assert.equal((await fetch('http://127.0.0.1:15040/webhooks/line',{method:'POST',headers:{'content-type':'application/json','x-line-signature':signature},body})).status,200);
      assert.equal((await fetch('http://127.0.0.1:15040/webhooks/line',{method:'POST',headers:{'content-type':'application/json'},body})).status,401);
    } finally {await isolated.stop();}
    await assert.rejects(()=>fetch('http://127.0.0.1:15040/healthz'));
    result = { reservations: 8, chatWinners: 1, enqueueWinners: 1, claimWinners: 1, reconnectRetainedBudget: true, stopRemovedContent: true, changedOwnerRejected: true,
      independentBundleRuntime: true, healthWebhookStop: true, nativeLineCatalog: true, concurrentWorkers: 8, scheduledAcquisitions: reads, pendingReconnectSends: sends, quoteAfterSendDeadline: true, normalDatabaseUsed: false, providerCalls: 0, mongoCrashTested: false };
  } finally {
    await client?.close(); child.kill('SIGTERM');
    const stop = await exited; assert.equal(stop.code, 0); if (result) result.mongoExitCode = stop.code;
  }
  const file = path.join(out, 'mongo-result.json'); fs.writeFileSync(file, JSON.stringify(result, null, 2));
  const fd = fs.openSync(file, 'r'); fs.fsyncSync(fd); fs.closeSync(fd); console.log(JSON.stringify(result));
}
main().catch(e => { console.error(e); process.exitCode = 1; });
