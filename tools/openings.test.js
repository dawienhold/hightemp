'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const O=require('../scripts/openings/core.js'),D=require('../scripts/openings/collector.js'),C=require('../scripts/consistency/core.js');
const cfg=require('../scripts/openings/config.json'),T=Date.parse('2026-10-01T13:45:00Z');
const rawMarket=(slug='band-a',date='2026-10-02',predicate='between 70F and 71F')=>({slug,active:true,closed:false,archived:false,status:'MARKET_STATUS_OPEN',outcomes:'["Yes","No"]',description:`Will the highest temperature recorded at Central Park (KNYC) in New York City for ${date} as reported by the National Weather Service's Climatological Report (Daily) be ${predicate}? Outcome verified from NWS Climatological Report.`,question:'Highest temperature in New York?',createdAt:C.iso(T-1000)});
const event=(date='2026-10-02')=>({slug:'temp-nychigh-'+date,title:'Highest temperature in New York?',active:true,closed:false,createdAt:C.iso(T-1000),markets:[rawMarket('band-a',date)]});
const payload=(now=T,slug='band-a',bid='.2',ask='.3')=>({marketData:{marketSlug:slug,state:'MARKET_STATE_OPEN',transactTime:C.iso(now),bids:bid==null?[]:[{px:{value:'0'+bid,currency:'USD'},qty:'12.50'}],offers:ask==null?[]:[{px:{value:'0'+ask,currency:'USD'},qty:'9.25'}]}});
const quote=(now=T)=>O.parseQuote(payload(now),'band-a',C.iso(now));
function root(){return fs.mkdtempSync(path.join(os.tmpdir(),'openings-test-'));}
function mock({r,now=T,present=true,empty=false,fail=false,newBand=false,date='2026-10-02',changed=false}={}) {
 let clock=now;const e=event(date);if(newBand)e.markets.push(rawMarket('band-b',date,'between 72F and 73F'));if(changed)e.markets[0].description=e.markets[0].description.replace('71F','72F');
 async function read(url){const u=new URL(url);clock+=5;if(fail)throw new Error('Network failure');let data;
  if(u.pathname==='/v1/search')data={events:present?[e]:[]};
  else if(u.pathname.includes('/events/')){if(!present||!u.pathname.endsWith(e.slug)){const er=new Error('HTTP 404');er.status=404;throw er;}data={event:e};}
  else data=payload(clock,u.pathname.split('/')[3],empty?null:'.2',empty?null:'.3');
  return {data,receivedAt:C.iso(clock),startedAt:C.iso(clock-5),url};
 }
 return new D.Collector(r,cfg,{clock:()=>clock,read});
}
test('local midnight does not reset identity and differs across station zones',()=>{
 assert.equal(O.phase({station:'KNYC',date:'2026-10-02'},Date.parse('2026-10-02T03:59Z')),'TOMORROW');
 assert.equal(O.phase({station:'KNYC',date:'2026-10-02'},Date.parse('2026-10-02T04:00Z')),'TODAY');
 assert.equal(O.phase({station:'KSFO',date:'2026-10-02'},Date.parse('2026-10-02T04:00Z')),'TOMORROW');
});
test('local checkpoints honor DST',()=>{assert.equal(C.iso(O.localInstant('2026-10-02',10,'KMDW')),'2026-10-02T15:00:00.000Z');assert.equal(C.iso(O.localInstant('2026-12-02',10,'KMDW')),'2026-12-02T16:00:00.000Z');});
test('YES and NO mapping reverses book sides and retains exact quantities',()=>{const q=quote();assert.equal(q.yesBid,200000);assert.equal(q.yesAsk,300000);assert.equal(q.noBid,700000);assert.equal(q.noAsk,800000);assert.equal(q.noBidQty,9.25);assert.equal(q.noAskQty,12.5);assert.equal(q.midpoint,250000);});
test('empty book is not a first usable quote',()=>{const q=O.parseQuote(payload(T,'band-a',null,null),'band-a',C.iso(T));assert.equal(q.usable,false);assert.equal(q.midpoint,null);});
test('one-sided book does not invent midpoint or opposite side',()=>{const q=O.parseQuote(payload(T,'band-a','.2',null),'band-a',C.iso(T));assert.equal(q.usable,true);assert.equal(q.midpoint,null);assert.equal(q.noAsk,800000);assert.equal(q.noBid,null);});
test('crossed book is flagged',()=>assert.equal(O.parseQuote(payload(T,'band-a','.4','.3'),'band-a',C.iso(T)).usable,false));
test('quiet source update time is retained separately from observation time',()=>{const q=O.parseQuote(payload(T-3600000),'band-a',C.iso(T));assert.equal(q.usable,true);assert.equal(q.sourceAgeSeconds,3600);});
test('cached HTTP book and future update time are unusable',()=>{assert.equal(O.parseQuote(payload(T),'band-a',C.iso(T),{httpAge:'120'}).usable,false);assert.equal(O.parseQuote(payload(T+5000),'band-a',C.iso(T)).usable,false);});
test('wrong market identity and currencies reject parsing',()=>{assert.throws(()=>O.parseQuote(payload(T),'wrong',C.iso(T)));const p=payload();p.marketData.bids[0].px.currency='EUR';assert.throws(()=>O.parseQuote(p,'band-a',C.iso(T)));});
test('checkpoint never looks ahead beyond tolerance or backward before target',()=>{
 const m={quotes:[quote(T-1),quote(T+11*O.MIN)]};const cp=O.checkpoint(m,C.iso(T),10,T+20*O.MIN);assert.equal(cp.status,'MISSING');
 const c=O.checkpoint({quotes:[quote(T+3*O.MIN)]},C.iso(T),10,T+20*O.MIN);assert.equal(c.status,'RECORDED');assert.equal(c.delayMinutes,3);
});
test('day prior stays at five minutes; morning returns to fifteen minutes',()=>{const e={station:'KNYC',date:'2026-10-02',firstQuoteAt:C.iso(T),lastSampleAt:C.iso(T),markets:{a:{firstQuoteAt:C.iso(T)}}};assert.equal(O.samplingDue(e,T+5*O.MIN),true);e.lastSampleAt=C.iso(T+90*O.MIN);assert.equal(O.samplingDue(e,T+95*O.MIN),true);const morning=Date.parse('2026-10-02T08:00Z');e.lastSampleAt=C.iso(morning);assert.equal(O.samplingDue(e,morning+5*O.MIN),false);assert.equal(O.samplingDue(e,morning+15*O.MIN),true);});
test('10 AM terminal observation bypasses overnight cadence once',()=>{const t=O.localInstant('2026-10-02',10,'KNYC'),e={station:'KNYC',date:'2026-10-02',lastSampleAt:C.iso(t-3*O.MIN)};assert.equal(O.samplingDue(e,t+2*O.MIN),true);e.lastSampleAt=C.iso(t+2*O.MIN);assert.equal(O.samplingDue(e,t+7*O.MIN),false);assert.equal(O.samplingDue(e,t+25*O.MIN),false);});
test('complete absence then appearance brackets first listing',async()=>{const r=root();try{await mock({r,present:false,now:T-10*O.MIN}).run();const s=await mock({r}).run(),e=s.events[0];assert.equal(e.capture,'BRACKETED');assert.ok(e.lastAbsentAt);assert.equal(e.markets[0].firstQuoteAt,e.firstQuoteAt);}finally{fs.rmSync(r,{recursive:true,force:true});}});
test('failure never advances last confirmed absence',async()=>{const r=root();try{await mock({r,present:false,now:T-10*O.MIN}).run();const s=await mock({r,fail:true}).run();assert.equal(s.discovery.complete,false);const st=JSON.parse(fs.readFileSync(path.join(r,'docs/data/openings/state.json')));assert.ok(Date.parse(st.watch['KNYC|2026-10-02'].lastAbsentAt)<T);}finally{fs.rmSync(r,{recursive:true,force:true});}});
test('installation baseline is not claimed as opening and empty books wait',async()=>{const r=root();try{const s=await mock({r,empty:true}).run();assert.equal(s.events[0].capture,'UNBRACKETED_BASELINE');assert.equal(s.events[0].firstQuoteAt,null);const next=await mock({r,now:T+5*O.MIN}).run();assert.ok(next.events[0].firstQuoteAt);}finally{fs.rmSync(r,{recursive:true,force:true});}});
test('new band keeps its own listing and first-quote time',async()=>{const r=root();try{const a=await mock({r}).run();const b=await mock({r,newBand:true,now:T+5*O.MIN}).run();assert.equal(a.events[0].firstSeenAt,b.events[0].firstSeenAt);const ms=b.events[0].markets;assert.equal(ms.length,2);assert.ok(Date.parse(ms[1].firstQuoteAt)>Date.parse(ms[0].firstQuoteAt));assert.equal(ms[1].capture,'BRACKETED');}finally{fs.rmSync(r,{recursive:true,force:true});}});
test('contract survives tomorrow-to-today and stores both phases',async()=>{const r=root();try{const a=await mock({r}).run();const b=await mock({r,now:Date.parse('2026-10-02T05:00Z')}).run();assert.equal(b.events[0].firstSeenAt,a.events[0].firstSeenAt);assert.equal(b.events[0].phase,'TODAY');const raw=JSON.parse(fs.readFileSync(path.join(r,'docs/data/openings/events/temp-nychigh-2026-10-02.json')));assert.deepEqual(raw.markets['band-a'].quotes.map(q=>q.phase),['TOMORROW','TODAY']);}finally{fs.rmSync(r,{recursive:true,force:true});}});
test('rules changes pause series without rewriting first quotes',async()=>{const r=root();try{await mock({r}).run();const s=await mock({r,changed:true,now:T+5*O.MIN}).run();assert.equal(s.events[0].markets[0].rulesChanged,true);assert.equal(s.events[0].markets[0].samples,1);}finally{fs.rmSync(r,{recursive:true,force:true});}});
test('public reader uses only unsigned GET and rejects order endpoints',async()=>{let opt;const read=D.createReader(cfg,{clock:()=>T,pause:async()=>{},transport:async(u,o)=>{opt=o;return {ok:true,headers:{get:()=>null},text:async()=>'{}'};}});await read('https://gateway.polymarket.us/v1/search');assert.equal(opt.method,'GET');assert.equal(opt.redirect,'error');assert.equal(Object.keys(opt.headers).some(x=>/auth|key/i.test(x)),false);await assert.rejects(read('https://gateway.polymarket.us/v1/orders'));});
test('malformed persistent state is not silently reset',()=>{const r=root();try{fs.mkdirSync(path.join(r,'docs/data/openings'),{recursive:true});fs.writeFileSync(path.join(r,'docs/data/openings/state.json'),'{broken');assert.throws(()=>mock({r}));}finally{fs.rmSync(r,{recursive:true,force:true});}});
