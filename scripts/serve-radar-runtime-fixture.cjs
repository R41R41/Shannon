'use strict';
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const { pathToFileURL } = require('node:url');
async function main() {
  const root = fs.realpathSync(path.join(__dirname, '..'));
  assert.equal(root, '/home/azureuser/Shannon-dev'); assert.deepEqual(process.argv.slice(2), ['--isolated-fixture']);
  assert(fs.existsSync(path.join(root,'.dev-runtime-lock')));
  const out = '/home/azureuser/.codex-shannon-preservation/radar-runtime-20260829'; fs.mkdirSync(out,{recursive:true,mode:0o700});
  const base = fs.mkdtempSync(path.join(out,'mongo-fixture-'));fs.mkdirSync(path.join(base,'db'),{mode:0o700});
  const mongo = spawn('/usr/bin/mongod',['--dbpath',path.join(base,'db'),'--port','37029','--bind_ip','127.0.0.1',
    '--wiredTigerCacheSizeGB','0.25','--setParameter','ttlMonitorEnabled=false','--setParameter','diagnosticDataCollectionEnabled=false','--logpath',path.join(base,'mongod.log')],{stdio:'ignore'});
  let client, host, stopping, timer; const proof = {fixtureOnly:true,normalDbWritten:false,realFirebase:false,realProviders:false,mongoPid:mongo.pid,fixtureDirectory:base};
  const stop = () => stopping ??= (async()=>{
    clearTimeout(timer);if(host)await host.stop();else await client?.close();
    if(mongo.exitCode===null){assert(fs.readFileSync(`/proc/${mongo.pid}/cmdline`).includes(Buffer.from(path.join(base,'db'))));mongo.kill('SIGTERM');await new Promise(resolve=>mongo.once('exit',resolve));}
    proof.mongoExitCode=mongo.exitCode;proof.mongoStopped=mongo.exitCode!==null;proof.stopped=true;
    fs.writeFileSync(path.join(out,'runtime-fixture-stop.json'),JSON.stringify(proof,null,2));console.log('RADAR_RUNTIME_FIXTURE_STOPPED');
  })();
  process.once('SIGINT',()=>{void stop().catch(()=>{process.exitCode=1;});});process.once('SIGTERM',()=>{void stop().catch(()=>{process.exitCode=1;});});
  try {
    const mongoose = require('mongoose');const uri='mongodb://127.0.0.1:37029/shannon_radar_runtime_fixture';
    for(let i=0;i<50;i++){
      assert.equal(mongo.exitCode,null);client=new mongoose.mongo.MongoClient(uri,{serverSelectionTimeoutMS:200,socketTimeoutMS:5000});
      try{await client.connect();break;}catch{await client.close();client=undefined;await new Promise(resolve=>setTimeout(resolve,100));}
    }
    assert(client);assert(fs.readFileSync(`/proc/${mongo.pid}/cmdline`).includes(Buffer.from(path.join(base,'db'))));
    let db=client.db('shannon_radar_runtime_fixture');assert.deepEqual(await db.listCollections({}, {nameOnly:true}).toArray(),[]);
    const load=file=>import(pathToFileURL(path.join(root,'backend/dist',file)).href);
    const { CATALOG_VALIDATOR }=await load('modules/radar/catalogVersion.js');
    const { radarRuntimeConfig }=await load('services/radar/runtimeConfig.js');
    const { createRadarApplication }=await load('services/radar/runtimeApplication.js');
    const { listenRadarHost }=await load('services/radar/runtimeHost.js');
    const { RadarMongoUsers,radarDatabaseReady }=await load('services/radar/runtimeAdapters.js');
    const { MongoPersonalCatalog }=await load('services/radar/mongoPersonalCatalog.js');
    const { dateAt,nextDate }=await load('services/radar/temporalParsing.js');
    await assert.rejects(radarDatabaseReady(db),/RADAR_CATALOG_FENCE_REQUIRED/);
    await db.createCollection('radarpersonalcatalogs',{validator:CATALOG_VALIDATOR,validationLevel:'strict',validationAction:'error'});
    await db.collection('users').insertMany(['alice','bob'].map(uid=>({firebaseProjectId:'radar-fixture',firebaseUid:uid,name:'架空ユーザー',email:`${uid}@example.test`,isAuthorized:true,isAdmin:true})));
    await radarDatabaseReady(db);proof.fenceRequired=true;
    const config=radarRuntimeConfig({version:1,environment:'dev',origin:'http://127.0.0.1:15030',port:15030,permitUntil:Date.now()+3600000,
      firebase:{projectId:'radar-fixture',apiKey:'a'.repeat(39),appId:'1:123:web:abc'},allowedUids:['alice','bob'],
      acquisition:{maxPer24Hours:24,minimumIntervalMs:0,leaseMs:30000},feedUrls:['https://example.org/feed'],weather:true});
    let feedCount=0,weatherCount=0;
    const identity={verify:async token=>{assert(['fixture-alice','fixture-bob'].includes(token));return {projectId:'radar-fixture',uid:token.slice(8),email:'synthetic@example.test',emailVerified:true,expiresAtMs:Date.now()+3590000};}};
    const feedHttp={get:async()=>{feedCount++;return `<feed><entry><id>fixture-news</id><title>独立Radarの架空ニュース</title><link href="https://example.org/item"/><published>${new Date(Date.now()-60000).toISOString()}</published></entry></feed>`;}};
    const weatherHttp={get:async url=>{weatherCount++;const u=new URL(url);const zone=u.searchParams.get('timezone');return JSON.stringify({latitude:Number(u.searchParams.get('latitude')),longitude:Number(u.searchParams.get('longitude')),timezone:zone,
      daily_units:{time:'iso8601',weather_code:'wmo code',temperature_2m_min:'°C',temperature_2m_max:'°C',precipitation_probability_max:'%'},
      daily:{time:[0,1,2].map(i=>nextDate(dateAt(Date.now(),zone),i)),weather_code:[0,3,61],temperature_2m_min:[21,22,20],temperature_2m_max:[29,28,25],precipitation_probability_max:[10,30,70]}});}};
    const {build}=await import('vite');await build({configFile:false,envDir:false,root:path.join(root,'frontend/tests/fixtures/radar-runtime'),resolve:{alias:{'@styles':path.join(root,'frontend/src/styles')}},esbuild:{jsx:'automatic'},build:{outDir:path.join(out,'site'),emptyOutDir:false},logLevel:'warn'});
    async function start(){const owned=client;const app=createRadarApplication(config,{identity,users:new RadarMongoUsers(db),catalog:new MongoPersonalCatalog(db),feedHttp,weatherHttp,ready:()=>radarDatabaseReady(db)});
      const express=require('express');app.app.use(express.static(path.join(out,'site'),{etag:false,lastModified:false,redirect:false}));host=await listenRadarHost(app,15030,()=>owned.close(),config.permitUntil);}
    await start();
    const request=(p,method='GET',body,uid='alice')=>fetch(config.origin+p,{method,headers:{authorization:`Bearer fixture-${uid}`,'content-type':'application/json'},...(body===undefined?{}:{body:JSON.stringify(body)})});
    assert.equal(feedCount+weatherCount,0);proof.noStartupFetch=true;
    const source={kind:'web',enabled:true,consentExpiresAt:Date.now()+86400000,locator:'https://example.org/feed',articleHosts:['example.org'],topicIds:['games'],maxItems:10,retentionMs:86400000};
    assert.equal((await request('/api/radar/sources/news','PUT',{expectedRevision:0,source})).status,200);
    assert.equal((await request('/api/radar/temporal/sources/weather','PUT',{expectedRevision:1,source:{kind:'weather',enabled:true,consentExpiresAt:Date.now()+86400000,timeZone:'Asia/Tokyo',latitudeTenth:350,longitudeTenth:1390}})).status,200);
    assert.equal((await request('/api/radar/collect','POST',{expectedRevision:2,sourceIds:['news','weather']})).status,200);
    const races=await Promise.all(Array.from({length:8},()=>request('/api/radar/collect','POST',{expectedRevision:6,sourceIds:['news']})));
    assert.equal(races.filter(r=>r.status===200).length,1);assert.equal(feedCount,2);assert.equal(weatherCount,1);proof.concurrentWinner=1;
    await host.stop();assert(!host.server.listening);host=undefined;
    client=new mongoose.mongo.MongoClient(uri,{serverSelectionTimeoutMS:5000,socketTimeoutMS:5000});await client.connect();db=client.db('shannon_radar_runtime_fixture');await radarDatabaseReady(db);await start();
    const view=await (await request('/api/radar/preview')).json();assert.equal(view.revision,8);assert.equal(view.items.length,1);assert.equal(view.temporal.length,1);
    const rows=await db.collection('radarpersonalcatalogs').find({}).toArray();assert.equal(rows.length,1);assert.equal(rows[0].acquisition.starts.length,3);proof.restartPreservedBudgetAndContent=true;
    assert.equal((await (await request('/api/radar/preview','GET',undefined,'bob')).json()).items.length,0);proof.ownerIsolated=true;
    proof.pid=process.pid;proof.port=15030;proof.journalEnabled=fs.readdirSync(path.join(base,'db','journal')).some(name=>name.startsWith('WiredTigerLog'));
    assert(proof.journalEnabled);fs.writeFileSync(path.join(out,'runtime-fixture-start.json'),JSON.stringify(proof,null,2));console.log(JSON.stringify(proof));
    timer=setTimeout(()=>{void stop();},600000);
    process.once('beforeExit',()=>{proof.feedCount=feedCount;proof.weatherCount=weatherCount;fs.writeFileSync(path.join(out,'runtime-fixture-stop.json'),JSON.stringify(proof,null,2));});
  }catch(error){proof.failure=error?.code??error?.message??'fixture failed';await stop();throw error;}
}
main().catch(error=>{console.error('RADAR_RUNTIME_FIXTURE_FAILED',error?.message);process.exitCode=1;});
