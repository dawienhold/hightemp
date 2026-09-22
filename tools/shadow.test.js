'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path'),zlib=require('node:zlib');
const C=require('../scripts/shadow/core.js');
const {Collector,allowedURL,createClient,readJSON}=require('../scripts/shadow/collector.js');
const cfg=require('../scripts/shadow/config.json');
const T=Date.parse('2026-09-21T21:30:00Z');
const slug='test-knyc-2026-09-21-64-65';
const description='Will the highest temperature recorded at Central Park (KNYC) in New York City for 2026-09-21 as reported by the National Weather Service\'s Climatological Report (Daily) be between 64F and 65F? Outcome verified from NWS Climatological Report.';
const rawMarket={slug,question:description,description,active:true,closed:false,archived:false,outcomes:'["Yes","No"]',minimumTradeQty:1,feeCoefficient:0.0695};
const event={slug:'temp-nychigh-2026-09-21',description:'',resolutionSource:'NWS Daily Climate Report',closed:false,markets:[rawMarket]};
function market(now=T){return C.parseMarket(rawMarket,event,now);}
function cli(now=T,max=66,date='2026-09-21',final=false) {
  return C.parseCLI({id:'sample-cli',issuanceTime:C.iso(now-60000),productText:`CLINYC\nCLIMATE REPORT\nTHE NEW YORK CITY CLIMATE SUMMARY FOR SEPTEMBER ${Number(date.slice(8))} 2026...\n${final?'':'VALID TODAY AS OF 0400 PM LOCAL TIME.\n'}TEMPERATURE (F)\n TODAY\n MAXIMUM ${max} 100 PM 95 1895 74 -2 71\n MINIMUM 61\nPRECIPITATION (IN)\n`},'KNYC',now);
}
function payload(now=T,{yesBid='0.05',qty='100',state='MARKET_STATE_OPEN'}={}) {
  return {marketData:{marketSlug:slug,bids:[{px:{value:yesBid,currency:'USD'},qty}],offers:[{px:{value:'0.10',currency:'USD'},qty:'100'}],state,transactTime:C.iso(now)}};
}
function book(now=T,opts={}) {return C.parseBook(payload(now,opts),slug,now,120);}
function state(e=cli()){return {schemaVersion:1,mode:'PAPER_ONLY',positions:{},signals:{},previousBooks:{},evidence:{[e.key]:e}};}
function metar(time,remarks,station='KNYC') {
  const d=new Date(time);const p=v=>String(v).padStart(2,'0');
  return {icaoId:station,obsTime:time/1000,rawOb:`${station} ${p(d.getUTCDate())}${p(d.getUTCHours())}${p(d.getUTCMinutes())}Z AUTO 04010KT 10SM CLR 22/10 A3000 RMK AO2 ${remarks}`};
}

test('config validates and cannot switch to live or international trading',()=>{
  C.validateConfig(cfg);assert.throws(()=>C.validateConfig({...cfg,mode:'LIVE'}));
  assert.throws(()=>C.validateConfig({...cfg,venue:'POLYMARKET_GLOBAL'}));
  assert.throws(()=>C.validateConfig({...cfg,pollSeconds:0}));
  assert.throws(()=>C.validateConfig({...cfg,feeCoefficient:'5'}));
});
test('network allowlist excludes all account, order, signing and external endpoints',()=>{
  for(const u of ['https://api.polymarket.us/v1/orders','https://gateway.polymarket.us/v1/orders',
    'https://gateway.polymarket.us/v1/portfolio','http://gateway.polymarket.us/v1/search',
    'https://clob.polymarket.com/book','https://evil.example/v1/search',
    'https://user:pass@gateway.polymarket.us/v1/search','https://gateway.polymarket.us:444/v1/search']) assert.throws(()=>allowedURL(u),u);
  assert.equal(allowedURL('https://gateway.polymarket.us/v1/search?query=weather').hostname,'gateway.polymarket.us');
});
test('network client can only issue unsigned GET with redirects rejected',async()=>{
  let calls=0;const read=createClient(cfg,async(url,init)=>{calls++;assert.equal(init.method,'GET');assert.equal(init.redirect,'error');assert(!init.body);assert(!init.headers.Authorization);return {ok:true,status:200,json:async()=>({events:[]})};});
  await read('https://gateway.polymarket.us/v1/search');assert.equal(calls,1);
  await assert.rejects(()=>read('https://gateway.polymarket.us/v1/orders'));assert.equal(calls,1);
});
test('USD decimal parser rejects floats with unknown scale and scientific/negative notation',()=>{
  assert.equal(C.units('0.97'),970000);assert.equal(C.units('100.00'),100000000);
  for(const x of ['-0.1','1e3','NaN','0.0000001',null]) assert.throws(()=>C.units(x));
});
test('banker rounding ties are exact and fee formula matches documented example',()=>{
  assert.equal(C.halfEven(25n,10n),2n);assert.equal(C.halfEven(35n,10n),4n);
  assert.equal(C.feesU([{priceU:C.units('0.95'),qty:100}],'0.0695'),330000);
});
test('climate date keeps daylight-time 00:30 in previous date and handles standard time',()=>{
  assert.equal(C.day(Date.parse('2026-09-22T04:30:00Z'),'KNYC'),'2026-09-21');
  assert.equal(C.day(Date.parse('2026-09-22T05:00:00Z'),'KNYC'),'2026-09-22');
  assert.equal(C.day(Date.parse('2026-01-22T05:00:00Z'),'KNYC'),'2026-01-22');
  assert.equal(C.day(Date.parse('2026-09-22T07:30:00Z'),'KLAX'),'2026-09-21');
});
test('range parser supports inclusive bounded and tail bands without parsing ISO dates',()=>{
  assert.deepEqual(C.parseBand('between 64F and 65F'),{low:64,high:65});
  assert.deepEqual(C.parseBand('64-65°F'),{low:64,high:65});
  assert.deepEqual(C.parseBand('63 or below'),{low:null,high:63});
  assert.deepEqual(C.parseBand('70F or above'),{low:70,high:null});
  assert.equal(C.parseBand('2026-09-21'),null);
  assert.equal(C.parseBand('between 64F and 65F or between 66F and 67F'),null);
});
test('market mapping verifies station date CLI Fahrenheit band and YES/NO',()=>{
  const m=market();assert(m.valid,m.issues.join('; '));assert.equal(m.station,'KNYC');assert.deepEqual(m.band,{low:64,high:65});assert.equal(m.date,'2026-09-21');
});
test('market mapping fails closed on missing station, different source, Celsius and side mismatch',()=>{
  for(const replacement of [description.replace('KNYC','KJFK'),description.replace('KNYC','KNYC and KMIA'),
    description.replace('2026-09-21','September 21'),description.replace('National Weather Service','Weather Underground').replaceAll('NWS','WU'),
    description.replaceAll('F','C')+' Celsius']) {
      assert(!C.parseMarket({...rawMarket,question:replacement,description:replacement},{...event,resolutionSource:''},T).valid,replacement);
  }
  assert(!C.parseMarket({...rawMarket,outcomes:'["No","Yes"]'},event,T).valid);
});
test('preliminary CLI gives evidence, not final settlement',()=>{
  const e=cli();assert(e);assert.equal(e.kind,'CLI_PRELIMINARY');assert.equal(e.floorF,66);
  assert.equal(C.gradeCLI({...market(),costU:1,qty:1},{[e.key]:e}),null);
});
test('CLI wrong station, future issuance, missing max and stale partial cannot settle',()=>{
  const p={id:'p',issuanceTime:C.iso(T-1000),productText:'CLIMIA\nCLIMATE SUMMARY FOR SEPTEMBER 21 2026\nTEMPERATURE (F)\nMAXIMUM 66'};
  assert.equal(C.parseCLI(p,'KNYC',T),null);
  assert.equal(C.parseCLI({...p,productText:p.productText.replace('CLIMIA','CLINYC'),issuanceTime:C.iso(T+1)},'KNYC',T),null);
  assert.equal(C.parseCLI({...p,productText:p.productText.replace('CLIMIA','CLINYC').replace('66','MM')},'KNYC',T),null);
  assert.equal(cli(T+86400000,66,'2026-09-21').kind,'CLI_PRELIMINARY');
});
test('six-hour group is conservative and T-group never creates execution evidence',()=>{
  const ts=Date.parse('2026-09-21T17:51:00Z');
  const e=C.parseMetar(metar(ts,'T02170100 10222 20111'),T);
  assert.equal(e.find(x=>x.kind==='ASOS_SIX_HOUR').floorF,72);
  assert.equal(e.find(x=>x.kind==='HOURLY_ADVISORY').floorF,null);
  const only=C.parseMetar(metar(ts,'T02170100'),T);
  assert.equal(C.chooseEvidence(Object.fromEntries(only.map(x=>[x.key,x])),'KNYC','2026-09-21',T).evidence,null);
});
test('whole-C 22 without extrema or T-group has no executable evidence',()=>{
  assert.deepEqual(C.parseMetar(metar(Date.parse('2026-09-21T17:51:00Z'),'AO2'),T),[]);
});
test('six-hour Celsius rounding margin prevents an ambiguous 65.48F from becoming 66',()=>{
  const e=C.parseMetar(metar(Date.parse('2026-09-21T17:51:00Z'),'10186'),T)[0];
  assert.equal(e.floorF,65);
});
test('six-hour window straddling climate-day boundary is rejected',()=>{
  assert.equal(C.parseMetar(metar(Date.parse('2026-09-21T05:51:00Z'),'10222'),T).length,0);
  assert.equal(C.parseMetar(metar(Date.parse('2026-09-21T11:51:00Z'),'10222','KMDW'),T).length,0);
});
test('METAR mismatched station, date and future observation rejected',()=>{
  const ts=Date.parse('2026-09-21T17:51:00Z'),m=metar(ts,'10222');
  assert.deepEqual(C.parseMetar({...m,icaoId:'KMIA'},T),[]);
  assert.deepEqual(C.parseMetar({...m,obsTime:ts/1000+3600},T),[]);
  assert.deepEqual(C.parseMetar(metar(T+60000,'10222'),T),[]);
});
test('later lower CLI conflicts with earlier six-hour floor instead of keeping a stale max',()=>{
  const six=C.parseMetar(metar(Date.parse('2026-09-21T17:51:00Z'),'10222'),T)[0];const cl=cli(T,71);
  const r=C.chooseEvidence({[six.key]:six,[cl.key]:cl},'KNYC','2026-09-21',T);
  assert(r.conflict);assert.equal(r.evidence.floorF,71);
});
test('NO purchase depth is complement of YES BIDS, not asks or a mid price',()=>{
  const b=book();assert.equal(b.bestNoAsk,0.95);assert.equal(b.noAsks[0].qty,100);
});
test('stale future halted crossed wrong-slug and wrong-currency books cannot trade',()=>{
  assert(!C.parseBook(payload(T-121000),slug,T,120).valid);
  assert(!C.parseBook(payload(T+1000),slug,T,120).valid);
  assert(!book(T,{state:'MARKET_STATE_HALTED'}).valid);
  assert(!book(T,{yesBid:'0.11'}).valid);
  assert.throws(()=>C.parseBook(payload(T),'other',T,120));
  const p=payload();p.marketData.bids[0].px.currency='CENTS';assert.throws(()=>C.parseBook(p,slug,T,120));
});
test('null or missing book timestamp is not converted into zero',()=>{
  const p=payload();delete p.marketData.transactTime;assert.throws(()=>C.parseBook(p,slug,T,120));
});
test('simulation requires available depth, includes fees, and respects cash cap',()=>{
  const s=C.simulate(book().noAsks,C.units('100'),cfg);assert(s);
  assert.equal(s.qty,50);assert.equal(s.averageNoPrice,0.96);assert(s.feeU>0);assert(s.costU<=C.units('100'));
  assert.equal(C.simulate([],C.units('100'),cfg),null);
  assert.equal(C.simulate(book().noAsks,C.units('0.50'),cfg),null);
});
test('adverse price buffer and minimum ROI reject thin high-price opportunities',()=>{
  assert.equal(C.simulate([{priceU:990000,qty:100}],C.units('100'),cfg),null);
  assert.equal(C.simulate([{priceU:970000,qty:100}],C.units('100'),cfg),null);
});
test('shared-depth confirmation excludes vanished and newly arrived price levels',()=>{
  assert.deepEqual(C.sharedDepth([{priceU:950000,qty:100}],[{priceU:950000,qty:30},{priceU:940000,qty:200}]),[{priceU:950000,qty:30}]);
});
test('first quote is observational; only a later quote can record one paper position',()=>{
  const s=state(),m=market(),sel={evidence:cli(),conflict:false};
  assert.equal(C.evaluate(s,m,book(),sel,cfg,T,true).status,'WAITING_FOR_LATER_BOOK');
  const r=C.evaluate(s,m,book(T+60000),sel,cfg,T+60000,true);
  assert.equal(r.status,'PAPER_ENTRY_RECORDED');assert.equal(Object.keys(s.positions).length,1);
  C.evaluate(s,m,book(T+120000),sel,cfg,T+120000,true);assert.equal(Object.keys(s.positions).length,1);
});
test('no entry during latency window, after long sampling gap or stale weather refresh',()=>{
  for(const [gap,fresh,expect] of [[1000,true,'EXECUTION_DELAY_NOT_REACHED'],[240000,true,'CONFIRMATION_GAP_TOO_LONG'],[60000,false,'WEATHER_REFRESH_STALE']]) {
    const s=state(),sel={evidence:cli(),conflict:false};C.evaluate(s,market(),book(),sel,cfg,T,true);
    assert.equal(C.evaluate(s,market(),book(T+gap),sel,cfg,T+gap,fresh).status,expect);
    assert.equal(Object.keys(s.positions).length,0);
  }
});
test('66 evidence cannot eliminate a band whose upper bound is 66; mismatched evidence rejected',()=>{
  assert.equal(C.classify({...market(),band:{low:65,high:66}},book(),{evidence:cli()},cfg,T).reason,'RANGE_NOT_ELIMINATED');
  assert.equal(C.classify(market(),book(),{evidence:{...cli(),station:'KMIA'}},cfg,T).reason,'UNSUPPORTED_OR_MISMATCHED_EVIDENCE');
  assert.equal(C.classify(market(),book(),{evidence:{...cli(),kind:'MADIS'}},cfg,T).reason,'UNSUPPORTED_OR_MISMATCHED_EVIDENCE');
});
test('changed rules and unknown per-market fee block entry',()=>{
  assert.equal(C.classify({...market(),rulesChanged:true},book(),{evidence:cli()},cfg,T).reason,'RULES_CHANGED_REVIEW');
  assert.equal(C.classify({...market(),feeCoefficient:695},book(),{evidence:cli()},cfg,T).reason,'MARKET_FEE_DIFFERS_REVIEW');
});
test('fee review expiry pauses simulations but not the collector',()=>{
  assert(C.feeIssue({...cfg,feeScheduleReviewedOn:'2026-07-01'},T));
});
test('cash risk budget spans correlated station bands and all open positions',()=>{
  const s=state();s.positions.a={station:'KNYC',date:'2026-09-21',enteredAt:C.iso(T),costU:C.units('240')};
  assert.equal(C.paperBudget(s,market(),cfg,T),C.units('10'));
  s.positions.a.costU=C.units('1000');assert.equal(C.paperBudget(s,market(),cfg,T),0);
});
test('final CLI grades separately and does not free paper cash',()=>{
  const now=Date.parse('2026-09-22T12:00:00Z'),e=cli(now,66,'2026-09-21',true);
  const s=state();const p={...market(),market:slug,station:'KNYC',date:'2026-09-21',enteredAt:C.iso(T),qty:10,costU:C.units('9.60')};
  p.cliGrade=C.gradeCLI(p,{[e.key]:e});assert(p.cliGrade.noWouldWin);assert.equal(p.cliGrade.netU,C.units('0.40'));
  s.positions[slug]=p;assert(C.paperBudget(s,{...market(),station:'KMIA'}, {...cfg,maxPaperSpendPerMarket:'1000',maxPaperSpendPerUtcDay:'2000',maxPaperSpendPerStationDay:'2000'},now)<C.units('1000'));
});
test('losing CLI check records a loss, never labels all evidence trades winners',()=>{
  const e=cli(Date.parse('2026-09-22T12:00:00Z'),65,'2026-09-21',true);
  const p={...market(),qty:10,costU:C.units('9.60')};
  const g=C.gradeCLI(p,{[e.key]:e});assert.equal(g.noWouldWin,false);assert.equal(g.netU,-C.units('9.60'));
});
test('a bare settlement 0 on an open/unresolved market cannot be graded as a win',()=>{
  const p={...market(),market:slug,qty:10,costU:C.units('9.60')};
  assert.equal(C.gradeExchange(p,{slug,settlement:0},market(),book(),T),null);
  assert.equal(C.gradeExchange(p,{slug,settlement:0},{...market(),closed:true,status:'MARKET_STATUS_CLOSED'},book(),T),null);
});
test('exchange finality supports win loss and alternative settlement, rejects changed rules',()=>{
  const p={...market(),market:slug,qty:10,costU:C.units('9.60')},m={...market(),closed:true,status:'MARKET_STATUS_RESOLVED'};
  assert.equal(C.gradeExchange(p,{slug,settlement:0},m,null,T).netU,C.units('0.40'));
  assert.equal(C.gradeExchange(p,{slug,settlement:1},m,null,T).netU,-C.units('9.60'));
  assert(C.gradeExchange(p,{slug,settlement:0.5},m,null,T).alternativeSettlement);
  assert.equal(C.gradeExchange(p,{slug,settlement:0},{...m,rulesHash:'new'},null,T),null);
});
test('corrupt persistent state is never silently reset',()=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'shadow-corrupt-'));
  try {const p=path.join(dir,'state.json');fs.writeFileSync(p,'{broken');assert.throws(()=>readJSON(p,{}));} finally {fs.rmSync(dir,{recursive:true,force:true});}
});
test('offline end-to-end collection, restart, delayed entry and forecast file preservation',async()=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'shadow-e2e-'));let clock=T;
  const c={...cfg,stations:['KNYC']};
  const read=async url=>{
    const u=new URL(url);let data;
    if(u.pathname==='/v1/search') data={events:[event]};
    else if(u.pathname.startsWith('/v1/market/slug/')) data={market:rawMarket};
    else if(u.pathname.endsWith('/book')) data=payload(clock);
    else if(u.pathname.endsWith('/observations')) throw new Error('Not implemented');
    else if(u.pathname==='/api/data/metar') data=[];
    else if(u.pathname==='/products/types/CLI/locations/NYC') data={'@graph':[{id:'test-cli',issuanceTime:C.iso(T-60000)}]};
    else if(u.pathname==='/products/test-cli') data={id:'test-cli',issuanceTime:C.iso(T-60000),productText:cli().raw};
    else throw new Error('Unexpected endpoint '+url);
    return {data,url,receivedAt:C.iso(clock),startedAt:C.iso(clock),durationMs:0};
  };
  try {
    fs.mkdirSync(path.join(dir,'docs','data'),{recursive:true});
    for(const f of ['state.json','stats.json','latest.json','cli.json']) fs.writeFileSync(path.join(dir,'docs','data',f),'DO NOT MODIFY '+f);
    const one=new Collector(dir,c,{read,clock:()=>clock});const a=await one.cycle();assert.equal(a.summary.paperEntries,0);
    clock+=60000;const two=new Collector(dir,c,{read,clock:()=>clock});const b=await two.cycle();assert.equal(b.summary.paperEntries,1);
    clock+=60000;const three=new Collector(dir,c,{read,clock:()=>clock});const d=await three.cycle();assert.equal(d.summary.paperEntries,1);
    for(const f of ['state.json','stats.json','latest.json','cli.json']) assert.equal(fs.readFileSync(path.join(dir,'docs','data',f),'utf8'),'DO NOT MODIFY '+f);
    const records=zlib.gunzipSync(fs.readFileSync(path.join(dir,'docs','data','shadow','history','2026-09-21.jsonl.gz'))).toString().trim().split('\n').map(JSON.parse);
    assert.equal(records.filter(r=>r.kind==='PAPER_ENTRY').length,1);
    assert(records.some(r=>r.kind==='BOOK'));
    assert(records.some(r=>r.kind==='WEATHER_FIRST_OBSERVED'));
  } finally {fs.rmSync(dir,{recursive:true,force:true});}
});
test('provider errors are displayed, not silently fabricated as healthy data',async()=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'shadow-fail-'));
  try {const c=new Collector(dir,{...cfg,stations:['KNYC']},{clock:()=>T,read:async()=>{throw new Error('HTTP 403');}});
    const r=await c.cycle();assert(r.errors.length>=2);assert.equal(r.summary.paperEntries,0);assert.equal(r.discovery.ok,false);
  } finally {fs.rmSync(dir,{recursive:true,force:true});}
});

test('documented singular market detail endpoint is accepted; guessed plural is rejected',()=>{
  assert.equal(allowedURL('https://gateway.polymarket.us/v1/market/slug/test').pathname,'/v1/market/slug/test');
  assert.throws(()=>allowedURL('https://gateway.polymarket.us/v1/markets/slug/test'));
});
test('decimal temperature bands cannot be interpreted as whole-degree fragments',()=>{
  assert.equal(C.parseBand('between 64.5F and 65.5F'),null);
  assert.equal(C.parseBand('64.5-65.5 F'),null);
});
test('unresolved or not-settled substrings never satisfy exchange finality',()=>{
  const p={market:slug,rulesHash:'x',qty:10,costU:C.units('9.50')};
  for(const status of ['MARKET_STATUS_UNRESOLVED','UNRESOLVED','NOT_SETTLED','PENDING_SETTLEMENT']) {
    assert.equal(C.gradeExchange(p,{slug,settlement:0},{closed:true,rulesHash:'x',status},null,T),null);
  }
});
test('a healthy unrelated source refresh does not revive an absent cached weather report',()=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'shadow-freshness-'));
  try {
    const co=new Collector(dir,cfg,{read:async()=>{throw Error('no network in test');},clock:()=>T});
    const e=cli();
    co.state.sourceChecks['cli:KNYC']={ok:true,checkedAt:C.iso(T),evidenceIds:['different-product']};
    assert.equal(co.weatherFresh('KNYC',e),false);
    co.state.sourceChecks['cli:KNYC'].evidenceIds.push(e.id);
    assert.equal(co.weatherFresh('KNYC',e),true);
    co.state.sourceChecks['cli:KNYC'].ok=false;
    assert.equal(co.weatherFresh('KNYC',e),false);
  } finally {fs.rmSync(dir,{recursive:true,force:true});}
});
