'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const C=require('../scripts/observations/core'),W=require('../scripts/observations/weights'),H=require('../scripts/observations/http');
const {ObservationCollector,atomic,readFile}=require('../scripts/observations/collector');
const S=require('../scripts/observations/shared'), cfg=require('../scripts/observations/config.json');
const now=Date.parse('2026-09-22T18:00:00Z');
const raw=(id='KNYC',time='221751',temp='21/10',remark='T02170100')=>`METAR ${id} ${time}Z AUTO 04005KT 10SM CLR ${temp} A3010 RMK AO2 ${remark}`;
const obs=(station,t,c,precise=true,extra={})=>({id:C.hash([station,t,c,extra]),station,t:C.iso(t),c,f:C.cToF(c),precise,precisionC:precise?.1:1,sixMaxC:null,raw:raw(station),source:'AWC',sourceUrl:'https://aviationweather.gov/api/data/metar',receivedAt:C.iso(t+30000),firstReceivedAt:C.iso(t+30000),...extra});
function rowsForFeatures(t=now){const a=t-3600000;return [obs('KNYC',a,20),obs('KLGA',a,21),obs('KLGA',t-60000,22),obs('KEWR',a,23),obs('KEWR',t-60000,24)];}
function training(){const a=[];for(let day=1;day<=12;day++)for(let i=0;i<12;i++){
 const d=`2026-09-${String(day).padStart(2,'0')}`,changeF=Math.sin(i*.8+day)*3;
 a.push({station:'KNYC',date:d,at:d+`T${String(i+5).padStart(2,'0')}:00:00Z`,horizon:'60',regime:'dry|N|day',changeF,deltas:{KLGA:changeF,KEWR:2*changeF},equalDelta:1.5*changeF});}
 return a;}
test('configuration bounds and station count',()=>{assert.equal(C.validate(cfg).enabled,true);assert.equal(C.allStations(cfg).length,21);assert.throws(()=>C.validate({...cfg,pollSeconds:1}));});
test('precise T-group decoded independently of rounded body',()=>{const r=C.parseMetar({rawOb:raw(),obsTime:Date.parse('2026-09-22T17:51Z')/1000},'AWC',now,'url',['KNYC']);assert.equal(r.c,21.7);assert.equal(r.precise,true);});
test('whole-C observation is not invented precision',()=>{const r=C.parseMetar({rawOb:raw('KNYC','221751','22/10',''),temp:22.000001},'NWS',now,'url',['KNYC']);assert.equal(r.precise,false);assert.equal(r.c,22);});
test('missing raw message cannot enter weather evidence',()=>assert.equal(C.fromNWS({timestamp:C.iso(now-60000),temperature:{value:22.222222}},'KNYC',now,'url',['KNYC']),null));
test('wrong station rejected',()=>assert.equal(C.parseMetar({icaoId:'KMIA',rawOb:raw()},'AWC',now,'url',['KNYC']),null));
test('future report rejected',()=>assert.equal(C.parseMetar({rawOb:raw('KNYC','221851')},'AWC',now,'url',['KNYC']),null));
test('timestamp mismatch rejected',()=>assert.equal(C.parseMetar({rawOb:raw(),obsTime:(now-60000)/1000},'AWC',now,'url',['KNYC']),null));
test('negative temperatures and extrema decode',()=>{const r=C.parseMetar({rawOb:raw('KNYC','221751','M02/M05','T10171050 11010')},'AWC',now,'url',['KNYC']);assert.equal(r.c,-1.7);assert.equal(r.sixMaxC,-1);});
test('invalid temperature values rejected',()=>assert.equal(C.parseMetar({rawOb:raw('KNYC','221751','99/10','T09990100')},'AWC',now,'url',['KNYC']),null));
test('month boundary resolution is validated',()=>{assert.equal(C.iso(C.resolveDay('312351',Date.parse('2026-02-01T00:10Z'))),'2026-01-31T23:51:00.000Z');assert.equal(C.resolveDay('222599',now),null);});
test('duplicate unchanged reports prefer first receipt',()=>{const a=obs('KNYC',now-600000,22),b={...a,source:'NWS',firstReceivedAt:C.iso(now)};assert.equal(C.selectRows([a,b],now)[0].source,'AWC');});
test('explicit correction can lower temperature',()=>{const a=obs('KNYC',now-600000,22),b=obs('KNYC',now-600000,21,true,{corrected:true});assert.equal(C.selectRows([a,b],now)[0].c,21);});
test('unexplained precise conflict abstains',()=>{const a=obs('KNYC',now-600000,22),b=obs('KNYC',now-600000,21);assert.equal(C.selectRows([a,b],now)[0].conflict,true);});
test('same temperature with extra six-hour group is not a conflict',()=>{const a=obs('KNYC',now-600000,22),b={...a,sixMaxC:23};const r=C.selectRows([a,b],now)[0];assert.equal(r.conflict,false);assert.equal(r.sixMaxC,23);});
test('OMO and inferred-source tags cannot enter selected input rows',()=>{assert.equal(C.selectRows([obs('KNYC',now-600000,22,true,{omo:true})],now).length,0);});
test('later received revisions are unavailable at an earlier as-of',()=>{const a=obs('KNYC',now-600000,22),b=obs('KNYC',now-600000,21,true,{corrected:true,firstReceivedAt:C.iso(now+5000)});assert.equal(C.selectRows([a,b],now)[0].c,22);});
const dsm='116\nCXUS41 KOKX 212115\nDSMNYC\nKNYC DS 1600 21/09 721300/ 610817// 72/ 61//9940050/';
test('actual published-style DSM parsed research-only',()=>{const d=C.parseDSM(dsm,'KNYC',now,'url');assert.equal(d.maxF,72);assert.equal(d.date,'2026-09-21');assert.equal(d.eligibleForLocks,false);assert.equal(d.advisoryOnly,true);});
test('wrong station DSM rejected',()=>assert.equal(C.parseDSM(dsm,'KMIA',now,'url'),null));
test('invalid DSM day or max time rejected',()=>{assert.equal(C.parseDSM(dsm.replace('21/09','31/09'),'KNYC',now,'url'),null);assert.equal(C.parseDSM(dsm.replace('721300/','722500/'),'KNYC',now,'url'),null);});
test('allowlist excludes orders, arbitrary hosts and plaintext HTTP',()=>{for(const u of ['https://gateway.polymarket.us/v1/orders','http://api.weather.gov/products/a','https://api.weather.gov.evil.com/products/a'])assert.throws(()=>H.allowed(u));});
test('weather client sends GET without financial credentials',async()=>{let options;const read=H.client(cfg,async(u,o)=>{options=o;return {ok:true,status:204,headers:new Headers()};});assert.deepEqual((await read('https://aviationweather.gov/api/data/metar')).data,[]);assert.equal(options.method,'GET');assert.equal(options.headers.Authorization,undefined);});
test('429 pauses subsequent requests instead of aggressive retries',async()=>{let calls=0;const read=H.client(cfg,async()=>{calls++;return {ok:false,status:429,headers:new Headers({'retry-after':'60'})};},()=>now);await assert.rejects(read('https://aviationweather.gov/api/data/metar'));await assert.rejects(read('https://aviationweather.gov/api/data/metar'));assert.equal(calls,1);});
test('paired neighbor changes are anchored per station, not averaged absolute temps',()=>{const f=W.features(rowsForFeatures(),'KNYC',now,cfg);assert.equal(f.ok,true);assert(Math.abs(f.equalDelta-1.8)<1e-8);assert.equal(f.inputs.length,2);});
test('future observations and late-arriving rows cannot enter features',()=>{const rr=rowsForFeatures();rr[2].firstReceivedAt=C.iso(now+1);assert.equal(W.features(rr,'KNYC',now,cfg).ok,false);});
test('a fresh target suppresses unnecessary inference',()=>{const rr=rowsForFeatures();rr.push(obs('KNYC',now-60000,21));assert.equal(W.features(rr,'KNYC',now,cfg).ok,false);});
test('stale anchor abstains',()=>{const rr=rowsForFeatures();rr[0].t=C.iso(now-100*60000);assert.equal(W.features(rr,'KNYC',now,cfg).ok,false);});
test('stale or missing neighbors cause abstention',()=>{const rr=rowsForFeatures();rr[2].t=C.iso(now-30*60000);assert.equal(W.features(rr,'KNYC',now,cfg).ok,false);});
test('cold start has no learned weights and prefers persistence',()=>{const p=W.nowcast(rowsForFeatures(),'KNYC',now,{},cfg);assert.equal(p.status,'COLLECTING_VALIDATION');assert.equal(p.preferredF,p.baselineF);assert.notEqual(p.candidateF,p.preferredF);assert.equal(p.eligibleForLocks,false);});
test('trained model must beat two baselines on later held-out days',()=>{const m=W.train(training(),'KNYC','60','2026-09-22','dry|N|day',cfg);assert.equal(m.mode,'VALIDATED_ADVISORY');assert(m.validationDays>=3);assert(m.mae<m.persistenceMAE&&m.mae<m.equalChangeMAE);assert(Math.abs(Object.values(m.weights).reduce((s,x)=>s+x.weight,0)-1)<1e-9);});
test('current and future days never enter model fitting',()=>{const rows=training();const a=W.train(rows,'KNYC','60','2026-09-10','dry|N|day',cfg);const b=W.train([...rows,{...rows[0],date:'2026-09-22',at:C.iso(now),changeF:1000}],'KNYC','60','2026-09-10','dry|N|day',cfg);assert.deepEqual(a,b);});
test('a good persistence baseline prevents automatic promotion',()=>{const rows=training().map(r=>({...r,changeF:0}));assert.equal(W.train(rows,'KNYC','60','2026-09-22','dry|N|day',cfg).mode,'BASELINE_BETTER');});
test('different anchor-age buckets do not borrow nonexistent validation samples',()=>assert.equal(W.train(training(),'KNYC','15','2026-09-22','dry|N|day',cfg).mode,'COLLECTING_VALIDATION'));
test('prospective scoring counts a target timestamp only once',()=>{const state={};const issue=now-60000;const p=W.nowcast(rowsForFeatures(issue),'KNYC',issue,state,cfg);W.rememberPrediction(state,p);const t=obs('KNYC',now,21,true,{firstReceivedAt:C.iso(now+60000)});W.gradeArrivals(state,[t],cfg,now+60000);W.gradeArrivals(state,[t],cfg,now+60000);assert.equal(state.training.length,1);});
test('cannot score forecasts issued after target observation time',()=>{const state={};const p=W.nowcast(rowsForFeatures(now+1000),'KNYC',now+1000,state,cfg);W.rememberPrediction(state,p);W.gradeArrivals(state,[obs('KNYC',now,21)],cfg,now+60000);assert.equal(state.training.length,0);});
test('cannot backfill performance from unrecorded earlier forecasts',()=>{const state={};W.gradeArrivals(state,[obs('KNYC',now-3600000,21)],cfg,now);assert.equal(state.training.length,0);});
test('label corrections remove the affected training row',()=>{const state={};const issue=now-60000;W.rememberPrediction(state,W.nowcast(rowsForFeatures(issue),'KNYC',issue,state,cfg));const t=obs('KNYC',now,21);W.gradeArrivals(state,[t],cfg,now+60000);W.gradeArrivals(state,[{...t,c:22,f:71.6,corrected:true}],cfg,now+60000);assert.equal(state.training.length,0);});
test('unknown or corrupt state does not silently reset',()=>{const root=fs.mkdtempSync(path.join(os.tmpdir(),'obs-corrupt-'));try{fs.writeFileSync(path.join(root,'bad.json'),'{bad');assert.throws(()=>readFile(path.join(root,'bad.json'),{}));}finally{fs.rmSync(root,{recursive:true,force:true});}});
test('shared rows reject inference and malformed/future snapshots',()=>{const d={rows:[obs('KNYC',now-60000,22),obs('KNYC',now-120000,23,true,{inferred:true})]};assert.equal(S.rowsFor(d,'KNYC',now-3600000,now).length,1);});
test('shared source reception times are not relabelled as current weather',()=>{const root=fs.mkdtempSync(path.join(os.tmpdir(),'obs-time-'));try{atomic(path.join(root,'docs/data/observations/shared.json'),{schemaVersion:1,generatedAt:C.iso(now+1000),rows:[]});assert.equal(S.load(root,now),null);}finally{fs.rmSync(root,{recursive:true,force:true});}});
test('a complete failed-network cycle preserves other dashboards and saves diagnostics',async()=>{const root=fs.mkdtempSync(path.join(os.tmpdir(),'obs-failure-'));try{
 const p=path.join(root,'docs/data');fs.mkdirSync(p,{recursive:true});fs.writeFileSync(path.join(p,'state.json'),'unchanged');
 const collector=new ObservationCollector(root,cfg,{clock:()=>now,read:async()=>{throw Error('synthetic offline');}});const s=await collector.cycle();assert.equal(s.health.ok,false);assert.equal(fs.readFileSync(path.join(p,'state.json'),'utf8'),'unchanged');assert(fs.existsSync(path.join(p,'observations/state.json')));
 }finally{fs.rmSync(root,{recursive:true,force:true});}});
test('fast source publishes while another source remains pending',async()=>{const root=fs.mkdtempSync(path.join(os.tmpdir(),'obs-parallel-'));try{
 const c=new ObservationCollector(root,cfg,{clock:()=>now,read:async()=>{}});let release;const slow=c.task('SLOW',()=>new Promise(r=>{release=r;}));
 await c.task('FAST',async()=>{c.add(obs('KNYC',now-60000,22));return {records:1,stations:['KNYC']};});
 assert.equal(S.load(root,now).rows.length,1);release({records:0});await slow;
 }finally{fs.rmSync(root,{recursive:true,force:true});}});
test('engine observed maximum ignores OMO and inferred values',()=>{const HT=require('../engine/engine');const r=HT.observedMax([{t:new Date(now),f:100,precise:true,inferred:true},{t:new Date(now),f:99,precise:true,omo:true}],'America/New_York','2026-09-22');assert.equal(r.max,null);});
test('engine starts NWS and AWC concurrently and keeps tenth-C evidence', async () => {
 // Unit-test both input sources explicitly. Otherwise the real repository's
 // shared.json leaks into this test after the first successful collector run.
 // Production MUST keep merging that cache; only this test uses an empty one.
 const HT = require('../engine/engine');
 const originalFetch = global.fetch, originalLoad = S.load;
 const seen = [];
 let release;
 const hold = new Promise(resolve => { release = resolve; });
 const stamp = Date.now() - 3600000, d = new Date(stamp);
 d.setUTCSeconds(0, 0);
 const code = [d.getUTCDate(), d.getUTCHours(), d.getUTCMinutes()]
  .map(x => String(x).padStart(2, '0')).join('');
 try {
  S.load = () => null;
  global.fetch = async url => {
   seen.push(String(url));
   if (String(url).includes('api.weather.gov')) {
    await hold;
    return {ok: true, json: async () => ({features: []})};
   }
   return {ok: true, json: async () => [
    {icaoId: 'KNYC', obsTime: +d / 1000, rawOb: raw('KNYC', code)}
   ]};
  };
  const pending = HT.fetchObs('KNYC', C.iso(Date.now() - 6 * 3600000), 6);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(seen.length, 2);
  release();
  const result = await pending;
  assert.equal(result.length, 1);
  assert.equal(result[0].precise, true);
 } finally {
  release();
  global.fetch = originalFetch;
  S.load = originalLoad;
 }
});

test('engine merges an explicit cached report with a fetched report', async () => {
 // Regression: the behavior that exposed the test-isolation bug is desirable.
 // A valid cached target report must not be thrown away to make a test pass.
 const HT = require('../engine/engine');
 const originalFetch = global.fetch, originalLoad = S.load;
 const nowMs = Date.now();
 const rowAt = hoursAgo => {
  const d = new Date(nowMs - hoursAgo * 3600000);
  d.setUTCSeconds(0, 0);
  const code = [d.getUTCDate(), d.getUTCHours(), d.getUTCMinutes()]
   .map(x => String(x).padStart(2, '0')).join('');
  return {icaoId: 'KNYC', obsTime: +d / 1000, rawOb: raw('KNYC', code)};
 };
 const cachedInput = rowAt(2), fetchedInput = rowAt(1);
 const cached = C.parseMetar(cachedInput, 'AWC', nowMs - 30000,
  'https://aviationweather.gov/api/data/metar', ['KNYC']);
 assert(cached);
 const doc = {schemaVersion: 1, generatedAt: C.iso(nowMs - 10000),
  rows: [cached], conflicts: []};
 const before = JSON.stringify(doc);
 let cacheLoads = 0;
 try {
  S.load = () => { cacheLoads++; return doc; };
  global.fetch = async url => ({ok: true, json: async () =>
   String(url).includes('api.weather.gov') ? {features: []} : [fetchedInput]});
  const result = await HT.fetchObs('KNYC', C.iso(nowMs - 6 * 3600000), 6);
  assert.equal(cacheLoads, 1);
  assert.equal(result.length, 2);
  assert(result.every(r => r.precise));
  assert.deepEqual(result.map(r => +r.t).sort((a, b) => a - b),
   [cachedInput.obsTime * 1000, fetchedInput.obsTime * 1000]);
  assert.equal(JSON.stringify(doc), before, 'Input snapshot must not be mutated');
 } finally {
  global.fetch = originalFetch;
  S.load = originalLoad;
 }
});

test('unresolved corrected-label disagreement invalidates its training score',()=>{const state={};const issue=now-60000;W.rememberPrediction(state,W.nowcast(rowsForFeatures(issue),'KNYC',issue,state,cfg));const a=obs('KNYC',now,21);W.gradeArrivals(state,[a],cfg,now+60000);assert.equal(state.training.length,1);W.gradeArrivals(state,[a,obs('KNYC',now,22)],cfg,now+60000);assert.equal(state.training.length,0);});
test('restart persists learned samples without resetting simulated capital',()=>{const root=fs.mkdtempSync(path.join(os.tmpdir(),'obs-restart-'));try{const a=new ObservationCollector(root,cfg,{clock:()=>now,read:async()=>{}});a.state.training=training();a.flush();const b=new ObservationCollector(root,cfg,{clock:()=>now,read:async()=>{}});assert.equal(b.state.training.length,144);assert.equal(fs.existsSync(path.join(root,'docs/data/shadow/state.json')),false);}finally{fs.rmSync(root,{recursive:true,force:true});}});
test('successful synthetic collection feeds shared CLI and raw reports into Shadow without extra weather requests',async()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'obs-integration-'));
 try{
  const read=async url=>{const u=new URL(url);let data;
   if(u.hostname==='aviationweather.gov')data=u.searchParams.get('ids').split(',').map(id=>({icaoId:id,obsTime:Date.parse('2026-09-22T17:51Z')/1000,rawOb:raw(id)}));
   else if(u.pathname.includes('/stations/'))data={features:[]};
   else if(u.pathname.includes('/products/types/')){const cli=u.pathname.split('/').at(-1);data={'@graph':[{id:'K'+cli+'-test',issuanceTime:'2026-09-22T17:58:00Z'}]};}
   else if(u.pathname.startsWith('/products/')){const id=u.pathname.split('/').at(-1),station=id.slice(0,4);data={id,issuanceTime:'2026-09-22T17:58:00Z',productText:`CLI${station.slice(1)}\nCLIMATE SUMMARY FOR SEPTEMBER 22 2026\nVALID TODAY AS OF 0100 PM LOCAL TIME.\nTEMPERATURE (F)\n MAXIMUM 72 100 PM\n`};}
   else throw Error('synthetic optional source unavailable');
   return {data,url,receivedAt:C.iso(now),startedAt:C.iso(now-50)};
  };
  const collector=new ObservationCollector(root,cfg,{clock:()=>now,read});const snap=await collector.cycle();assert(snap.health.ok);assert.equal(snap.stations[0].evidence.evidence.floorF,72);
  const {Collector}=require('../scripts/shadow/collector');const sh=new Collector(root,require('../scripts/shadow/config.json'),{clock:()=>now,read:async()=>{throw Error('Weather network should be skipped');}});
  await sh.weather();assert.equal(sh.errors.length,0);assert.equal(sh.state.sourceChecks.aviation.via,'shared observation collector');
  const CShadow=require('../scripts/shadow/core');const selection=CShadow.chooseEvidence(sh.state.evidence,'KNYC','2026-09-22',now);assert.equal(selection.evidence.floorF,72);assert(sh.weatherFresh('KNYC',selection.evidence));
  assert.equal(fs.existsSync(path.join(root,'docs/data/latest.json')),false);
 }finally{fs.rmSync(root,{recursive:true,force:true});}
});
test('stale shared file never suppresses normal Shadow weather fallback',()=>{const root=fs.mkdtempSync(path.join(os.tmpdir(),'obs-stale-'));try{atomic(path.join(root,'docs/data/observations/shared.json'),{schemaVersion:1,generatedAt:C.iso(now-600000),rows:[]});const status=S.ingestShadow({root,clock:()=>now,cfg:{stations:['KNYC']}});assert.equal(status.aviation,false);assert.equal(status.cli.size,0);}finally{fs.rmSync(root,{recursive:true,force:true});}});
test('weather request is bounded even when the transport ignores AbortSignal',async()=>{const read=H.client({...cfg,requestTimeoutMs:20},()=>new Promise(()=>{}));await assert.rejects(read('https://aviationweather.gov/api/data/metar'),/timeout/);});
test('fresh shared AWC check cannot revive an absent cached six-hour report',()=>{const root=fs.mkdtempSync(path.join(os.tmpdir(),'obs-absent-'));try{
 const t=Date.parse('2026-09-22T17:51Z'),r=C.parseMetar({icaoId:'KNYC',obsTime:t/1000,rawOb:raw('KNYC','221751','22/10','T02200100 10220')},'AWC',now,'url',['KNYC']);
 atomic(path.join(root,'docs/data/observations/shared.json'),{schemaVersion:1,generatedAt:C.iso(now),rows:[r],products:[],checks:{'AWC:KNYC':{ok:true,checkedAt:C.iso(now),stations:['KNYC'],recordIds:['unrelated-report']}}});
 const {Collector}=require('../scripts/shadow/collector'),s=new Collector(root,{...require('../scripts/shadow/config.json'),stations:['KNYC']},{clock:()=>now,read:async()=>{}});
 const status=S.ingestShadow(s);assert.equal(status.aviation,false);
 const six=Object.values(s.state.evidence).find(e=>e.kind==='ASOS_SIX_HOUR');assert(six);assert.equal(s.weatherFresh('KNYC',six),false);
 }finally{fs.rmSync(root,{recursive:true,force:true});}});

// v4.2.1 cadence / explicit nowcast-state regressions. All responses are synthetic.
const nwsURL=id=>`https://api.weather.gov/stations/${id}/observations?limit=36`;
const fields=(id='KMIA',t=now-60000,value=25,qc='V',unit='wmoUnit:degC')=>({
 station:`https://api.weather.gov/stations/${id}`,timestamp:C.iso(t),rawMessage:null,
 temperature:{value,unitCode:unit,qualityControl:qc}
});
function structured(id,t,c=25,qc='V'){return C.fromNWS(fields(id,t,c,qc),id,now,nwsURL(id),[id]);}
test('QC-passed structured NWS row survives without fake raw text or precision',()=>{
 const r=structured('KMIA',now-60000,25.555555);assert(r);assert(r.structured);assert(r.advisoryOnly);
 assert.equal(r.precise,false);assert.equal(r.precisionC,null);assert.equal(r.sixMaxC,null);assert.equal(r.raw,'');assert.equal(r.trendEligible,true);
 assert.equal(C.selectRows([r],now).length,1);
});
for(const qc of ['C','S','V','G','T'])test(`structured QC ${qc} permits trend research only`,()=>{const r=structured('KMIA',now-60000,25,qc);assert(C.usableTemperature(r));assert.equal(r.eligibleForLocks,false);});
for(const qc of ['X','Q','B','I','W'])test(`structured QC ${qc} is rejected, not interpreted as an observed extreme`,()=>{assert.equal(structured('KMIA',now-60000,25,qc),null);});
for(const qc of ['Z',null,'UNKNOWN'])test(`unverified QC ${qc} is visible but not a model input`,()=>{const r=structured('KMIA',now-60000,25,qc);assert(r);assert.equal(C.usableTemperature(r),false);assert.equal(C.selectRows([r],now).length,1);});
test('structured Fahrenheit and Kelvin convert explicitly',()=>{
 const a=C.fromNWS(fields('KMIA',now-60000,77,'V','wmoUnit:degF'),'KMIA',now,nwsURL('KMIA'),['KMIA']);
 const b=C.fromNWS(fields('KMIA',now-60000,298.15,'V','wmoUnit:K'),'KMIA',now,nwsURL('KMIA'),['KMIA']);
 assert.equal(a.c,25);assert(Math.abs(b.c-25)<1e-8);
});
for(const value of [null,'25',NaN,Infinity,99,-99])test(`invalid structured numeric value ${value} rejected`,()=>assert.equal(structured('KMIA',now-60000,value),null));
test('missing or unsupported structured unit is never guessed',()=>{
 for(const unit of [null,'','F','wmoUnit:degR'])assert.equal(C.fromNWS(fields('KMIA',now-60000,25,'V',unit),'KMIA',now,nwsURL('KMIA'),['KMIA']),null);
});
test('structured source and station must agree',()=>{
 const p=fields('KMIA');assert.equal(C.fromNWS(p,'KNYC',now,nwsURL('KNYC'),['KNYC']),null);
 assert.equal(C.fromNWS(p,'KMIA',now,nwsURL('KNYC'),['KMIA']),null);
 assert.equal(C.fromNWS(p,'KMIA',now,'https://api.weather.gov.evil.test/stations/KMIA/observations',['KMIA']),null);
});
test('structured future/timezone-free timestamps rejected',()=>{
 assert.equal(structured('KMIA',now+1000),null);const p=fields();p.timestamp='2026-09-22T17:59:00';
 assert.equal(C.fromNWS(p,'KMIA',now,nwsURL('KMIA'),['KMIA']),null);
});
for(const wrap of [s=>'123\n'+s,s=>'2026/09/22 17:51\n'+s,s=>'\x01123\nSAUS42 KWBC 221800\n'+s+'=\x03'])test('known raw wrapper preserved without loss of T-group',()=>{
 const x=C.parseMetar({rawOb:wrap(raw()),obsTime:Date.parse('2026-09-22T17:51Z')/1000},'AWC',now,'url',['KNYC']);assert(x);assert.equal(x.c,21.7);assert.equal(x.precise,true);
});
test('arbitrary prose or multiple raw reports are not accepted as wrappers',()=>{
 assert.equal(C.parseMetar({rawOb:'arbitrary text '+raw()},'NWS',now,'url',['KNYC']),null);
 assert.equal(C.parseMetar({rawOb:raw()+'\n'+raw('KMIA')},'NWS',now,'url',['KNYC','KMIA']),null);
});
test('present invalid raw report cannot be laundered through structured fallback',()=>{
 const p=fields('KNYC',Date.parse('2026-09-22T17:51Z'));
 for(const x of [raw('KMIA'),raw('KNYC','221851'),raw('KNYC','221751','99/10','T09990100'),'unrecognized '+raw()]){
  assert.equal(C.fromNWS({...p,rawMessage:x},'KNYC',now,nwsURL('KNYC'),['KNYC']),null);
 }
});
test('raw precise report wins over observation-only fallback at same timestamp',()=>{
 const t=Date.parse('2026-09-22T17:51Z'),a=structured('KNYC',t,30),b=C.parseMetar({rawOb:raw(),obsTime:t/1000},'AWC',now,'url',['KNYC']);
 const r=C.selectRows([a,b],now);assert.equal(r.length,1);assert.equal(r[0].c,21.7);assert.equal(r[0].conflict,false);
});
test('unexplained contradictory structured reports are not averaged',()=>{
 const a=structured('KNYC',now-60000,25),b=structured('KNYC',now-60000,26);
 assert.equal(C.selectRows([a,b],now)[0].conflict,true);
});
test('structured records cannot raise the engine climate floor or quantization evidence',()=>{
 const HT=require('../engine/engine');const a={...structured('KNYC',now-60000,40),t:new Date(now-60000)};
 assert.equal(HT.observedMax([a],'America/New_York','2026-09-22').max,null);
 const r=HT.observedMax([a,{t:new Date(now-3600000),f:71.06,c:21.7,precise:true}],'America/New_York','2026-09-22');
 assert.equal(r.max,71.06);assert.equal(r.coarsePeak,null);
});
test('structured cached records are revalidated and not re-timestamped',()=>{
 const r=structured('KNYC',now-600000,25),doc={rows:[r]};const a=S.rowsFor(doc,'KNYC',now-3600000,now);
 assert.equal(a.length,1);assert.equal(a[0].firstReceivedAt,r.firstReceivedAt);assert.equal(a[0].precise,false);
 assert.equal(S.rowsFor({rows:[{...r,c:30}]},'KNYC',now-3600000,now).length,0);
});
test('structured cache never supplies Shadow climate evidence',()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'obs-structured-shadow-'));
 try{
  atomic(path.join(root,'docs/data/observations/shared.json'),{schemaVersion:1,generatedAt:C.iso(now),rows:[structured('KNYC',now-60000,40)],products:[],checks:{}});
  const {Collector}=require('../scripts/shadow/collector');const sh=new Collector(root,{...require('../scripts/shadow/config.json'),stations:['KNYC']},{clock:()=>now,read:async()=>{}});
  S.ingestShadow(sh);assert.equal(Object.keys(sh.state.evidence).length,0);
 }finally{fs.rmSync(root,{recursive:true,force:true});}
});
test('restored structured neighbors can provide pairs without learned weights',()=>{
 const a=now-3600000;const rr=[obs('KNYC',a,20),structured('KLGA',a,21),structured('KLGA',now-60000,22),structured('KEWR',a,22),structured('KEWR',now-60000,23)];
 const nc=W.nowcast(rr,'KNYC',now,{},cfg);assert.equal(nc.ok,true);assert.equal(nc.status,'COLLECTING_VALIDATION');assert.equal(nc.inputs.length,2);
 assert.equal(nc.preferredF,nc.baselineF);assert.equal(nc.eligibleForLocks,false);
});
test('an unchanged neighbor temperature still counts when its timestamp advances',()=>{
 const rr=rowsForFeatures();rr[2].c=rr[1].c;rr[2].f=rr[1].f;rr[4].c=rr[3].c;rr[4].f=rr[3].f;
 const nc=W.nowcast(rr,'KNYC',now,{},cfg);assert(nc.ok);assert.equal(nc.equalDelta,0);
});
test('fresh-target status is not confused with missing-data abstention',()=>{
 const rr=rowsForFeatures();rr.push(obs('KNYC',now-60000,21));const nc=W.nowcast(rr,'KNYC',now,{},cfg);
 assert.equal(nc.status,'FRESH_TARGET');assert.equal(nc.candidateF,null);assert.equal(nc.preferredF,C.cToF(21));
});
test('each unavailable paired neighbor has an explicit reason',()=>{
 const rr=rowsForFeatures();rr[2].t=C.iso(now-30*60000);const nc=W.nowcast(rr,'KNYC',now,{},cfg);
 assert.equal(nc.status,'INSUFFICIENT_NEIGHBORS');assert(nc.neighborDiagnostics.some(x=>x.station==='KLGA'&&x.status==='NEIGHBOR_TOO_OLD'));
 assert(nc.neighborDiagnostics.some(x=>x.station==='KJRB'&&x.status==='NO_USABLE_NEIGHBOR_REPORT'));
});
test('missing precise anchor remains different from insufficient validation days',()=>{
 const rr=[structured('KNYC',now-60000,20)];const nc=W.nowcast(rr,'KNYC',now,{},cfg);
 assert.equal(nc.status,'NO_PRECISE_ANCHOR');assert.equal(nc.candidateF,null);
});
test('recent cadence and latest age are independent',()=>{
 const rr=Array.from({length:12},(_,i)=>obs('KMIA',now-(i*5+20)*60000,25));const d=C.cadenceInfo(rr,now);
 assert.equal(d.recentSpacingMinutes,5);assert.equal(d.latestAgeMinutes,20);assert.equal(d.recentRows,12);
});
test('NWS collector reports structured retained/rejected counts and reasons',async()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'nws-counts-'));try{
  const c=new ObservationCollector(root,cfg,{clock:()=>now,read:async url=>{
   const id=new URL(url).pathname.split('/')[2];return {url,receivedAt:C.iso(now),data:{features:[{properties:fields(id,now-60000,25)},{properties:fields(id,now-60000,25,'X')}]}};
  }});await c.nws();const x=c.state.checks['NWS:KMIA'];assert.equal(x.records,1);assert.equal(x.supplied,2);assert.equal(x.structuredRecords,1);assert.equal(x.rejected,1);assert.equal(x.rejectionReasons.TEMPERATURE_QC_X,1);
 }finally{fs.rmSync(root,{recursive:true,force:true});}
});
for(const id of ['KMIA','KMDW','KSFO','KLAX'])test(`engine retains five-minute structured ${id} observations alongside hourly reports`,async()=>{
 const HT=require('../engine/engine'),saveFetch=global.fetch,saveLoad=S.load;const end=new Date(Date.now()-5*60000);end.setUTCSeconds(0,0);
 const stamps=Array.from({length:36},(_,i)=>+end-i*5*60000),hourly=[+end-1*60000,+end-61*60000,+end-121*60000];
 const dd=t=>{const d=new Date(t);return [d.getUTCDate(),d.getUTCHours(),d.getUTCMinutes()].map(x=>String(x).padStart(2,'0')).join('');};
 try{
  S.load=()=>null;global.fetch=async url=>({ok:true,json:async()=>String(url).includes('api.weather.gov')?{features:stamps.map(t=>({properties:fields(id,t,25)}))}:hourly.map(t=>({icaoId:id,obsTime:t/1000,rawOb:raw(id,dd(t),'25/10','T02500100')}))});
  const r=await HT.fetchObs(id,C.iso(+end-4*3600000),4);assert.equal(r.length,39);assert.equal(r.filter(x=>x.structured).length,36);assert.equal(r.filter(x=>x.precise).length,3);assert.equal(r.inputCadence.recentSpacingMinutes,5);
  assert.equal(r.inputDiagnostics.NWS.structuredRecords,36);
 }finally{global.fetch=saveFetch;S.load=saveLoad;}
});
test('one failed observation source is visible while the other still supplies data',async()=>{
 const HT=require('../engine/engine'),saveFetch=global.fetch,saveLoad=S.load;const d=new Date(Date.now()-60000);d.setUTCSeconds(0,0);
 const code=[d.getUTCDate(),d.getUTCHours(),d.getUTCMinutes()].map(x=>String(x).padStart(2,'0')).join('');
 try{
  S.load=()=>null;global.fetch=async url=>{if(String(url).includes('api.weather.gov'))throw Error('synthetic timeout');return {ok:true,json:async()=>[{icaoId:'KMIA',obsTime:+d/1000,rawOb:raw('KMIA',code)}]};};
  const r=await HT.fetchObs('KMIA',C.iso(+d-3600000),1);assert.equal(r.length,1);assert.equal(r.inputDiagnostics.NWS.ok,false);assert.match(r.inputDiagnostics.NWS.error,/timeout/);assert.equal(r.inputDiagnostics.AWC.ok,true);
 }finally{global.fetch=saveFetch;S.load=saveLoad;}
});
test('a known unresolved shared conflict still blocks the forecast evidence stream',async()=>{
 const HT=require('../engine/engine'),saveFetch=global.fetch,saveLoad=S.load;const d=new Date(Date.now()-60000);d.setUTCSeconds(0,0);
 const code=[d.getUTCDate(),d.getUTCHours(),d.getUTCMinutes()].map(x=>String(x).padStart(2,'0')).join('');
 try{
  S.load=()=>({rows:[],conflicts:[{station:'KMIA',t:d.toISOString()}]});
  global.fetch=async url=>({ok:true,json:async()=>String(url).includes('api.weather.gov')?{features:[]}:[{icaoId:'KMIA',obsTime:+d/1000,rawOb:raw('KMIA',code)}]});
  assert.equal((await HT.fetchObs('KMIA',C.iso(+d-3600000),1)).length,0);
 }finally{global.fetch=saveFetch;S.load=saveLoad;}
});
test('precise target requirement and validation minimums remain unchanged',()=>{
 assert.equal(cfg.maxAnchorMinutes,90);assert.equal(cfg.maxNeighborAgeMinutes,25);
 assert.equal(cfg.minTrainingDays,5);assert.equal(cfg.minTrainingSamples,40);
 assert.equal(cfg.minValidationDays,3);assert.equal(cfg.minValidationSamples,12);assert.equal(cfg.improvementRequired,.05);
});
