'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const R=require('../scripts/openings/research.js'),O=require('../scripts/openings/core.js'),{Collector}=require('../scripts/openings/collector.js'),cfg=require('../scripts/openings/config.json');
const at='2026-10-02T16:00:00.000Z',t=Date.parse(at),event={station:'KNYC',date:'2026-10-03',firstSeenAt:at},market={slug:'a',band:{low:70,high:71},capture:'BRACKETED',firstSeenAt:at,lastAbsentAt:'2026-10-02T15:55:00Z',firstQuoteAt:at};
const latest={ranAt:'2026-10-02T15:50:00Z',stations:[{station:'KNYC',modelVersion:'x',tomorrow:{date:'2026-10-03',buckets:[{f:69,p:0.1},{f:70,p:0.4},{f:71,p:0.3},{f:72,p:0.2}],models:[{m:'A',v:70}],point:70}}]};
const raw=(stamp=at)=>({marketData:{marketSlug:'a',transactTime:stamp,state:'MARKET_STATE_OPEN',bids:[{px:{value:'0.3',currency:'USD'},qty:'5.25'},{px:{value:'0.29',currency:'USD'},qty:'100'}],offers:[{px:{value:'0.35',currency:'USD'},qty:'5.5'},{px:{value:'0.4',currency:'USD'},qty:'100'}]}});
test('archive keeps every fractional depth level and distinguishes partial sweeps',()=>{
 const q=O.parseQuote(raw(),'a',at);assert.equal(q.depth.bids[0].q,5.25);assert.equal(q.depth.asks.length,2);
 const fill=R.sweep(q.depth.asks,10,'buy',cfg.feeAssumption);assert.equal(fill.complete,true);assert.ok(Math.abs(fill.vwapU-372500)<1e-6);
 assert.ok(fill.estimatedCashUsd>fill.grossUsd);assert.equal(R.sweep(q.depth.asks,200,'buy',cfg.feeAssumption).complete,false);
});
test('forecasts are exact-date, fresh, independent snapshots without future leakage',()=>{
 const f=R.captureForecast(latest,event,at);assert.equal(f.status,'RECORDED');assert.equal(f.ageMinutes,10);
 f.snapshot.models[0].v=0;assert.equal(latest.stations[0].tomorrow.models[0].v,70);
 assert.equal(R.captureForecast(latest,event,'2026-10-02T15:49Z').status,'FUTURE_FORECAST_REJECTED');
 assert.equal(R.captureForecast(latest,event,'2026-10-02T18:00Z').status,'FORECAST_TOO_OLD');
 assert.equal(R.captureForecast(latest,{...event,date:'2026-10-04'},at).status,'CONTRACT_DATE_NOT_IN_FORECAST');
 const stale=structuredClone(latest);stale.stations[0].stale=true;assert.equal(R.captureForecast(stale,event,at).status,'STATION_FORECAST_UNAVAILABLE');
});
test('forecast probabilities honor inclusive bounds, tails and tied leaders',()=>{
 const ps=R.bandProbabilities(latest.stations[0].tomorrow,[market,{slug:'b',band:{low:null,high:69}},{slug:'c',band:{low:72,high:null}}]);
 assert.ok(Math.abs(ps.a.probability-0.7)<1e-10);assert.equal(ps.a.rank,1);assert.equal(ps.b.rank,3);assert.equal(ps.c.probability,0.2);
 const tie=R.bandProbabilities({buckets:[{f:70,p:0.5},{f:72,p:0.5}]},[market,{slug:'b',band:{low:72,high:73}}]);assert.equal(tie.b.rank,1);
});
test('quote stores forecast reference, local time and quantity scenarios',()=>{
 const f=R.captureForecast(latest,event,at),q=R.enrichQuote(O.parseQuote(raw(),'a',at),event,market,f,{probability:0.7,rank:1},cfg);
 assert.equal(q.timing.localHour,12);assert.equal(q.timing.minutesSinceFirstQuote,0);assert.equal(q.timing.minutesToContractMidnight,720);
 assert.equal(q.forecastId,f.id);assert.equal(q.modelRank,1);assert.equal(q.hypotheticalFills.sellYes[10].complete,true);
});
test('day-prior extrema exclude next-day quotes and exits preceding an entry',()=>{
 const q=(stamp,bid,ask)=>({at:stamp,usable:true,yesBid:bid,yesAsk:ask});
 const m={...market,quotes:[q('2026-10-02T15:59Z',900000,null),q(at,300000,350000),q('2026-10-02T19:00Z',500000,550000),q('2026-10-03T04:00Z',990000,995000)]};
 const s=R.summarizeMarket(m,event,Date.parse('2026-10-03T05:00Z'));assert.equal(s.maximumBid.value,900000);assert.equal(s.maximumBidAfterFirstAsk.value,500000);assert.equal(s.firstAskToLaterPeakGrossU,150000);assert.equal(s.usableObservations,3);assert.equal(s.minimumAsk.localHour,12);
});
test('old records stay missing depth and forecasts; late forecasts are not opening selections',()=>{
 const m={...market,quotes:[{at,usable:true,yesAsk:350000,yesBid:300000},{at:'2026-10-02T19:00Z',usable:true,yesAsk:400000,yesBid:390000,forecastStatus:'RECORDED',modelRank:1,modelProbability:0.7}]};
 const s=R.summarizeMarket(m,event,t+4*3600000);assert.equal(s.fullDepthObservations,0);assert.equal(s.hasOpeningForecast,false);assert.equal(s.forecastObservations,1);
});
test('report weights event days equally and includes losing/flat days',()=>{
 const make=(price,count)=>{const qs=Array.from({length:count},(_,i)=>({at:new Date(t+i*O.MIN).toISOString(),usable:true,yesAsk:price,yesBid:price-50000,forecastStatus:'RECORDED',modelRank:1,modelProbability:0.7}));return {...event,markets:[{...market,research:R.summarizeMarket({...market,quotes:qs},event,t+86400000)}]};};
 const report=R.stationReport([make(300000,10),make(500000,1)],t+86400000).stations[0];
 assert.equal(report.openingForecastEventDays,2);assert.equal(report.buyByLocalHour[12].eventDays,2);assert.equal(report.buyByLocalHour[12].meanU,400000);assert.equal(report.status,'ACCUMULATING');
});
test('collector persists forecast/depth and keeps index light across reloads',async()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'openings-research-'));
 const rawMarket={slug:'a',active:true,closed:false,outcomes:['Yes','No'],description:"Will the highest temperature recorded at Central Park (KNYC) in New York City for 2026-10-03 as reported by the National Weather Service's Climatological Report (Daily) be between 70F and 71F? Outcome verified from NWS Climatological Report."};
 const e={slug:'temp-nychigh-2026-10-03',markets:[rawMarket]};
 const read=async url=>({data:url.includes('/search')?{events:[e]}:url.includes('/events/')?{event:e}:raw(),receivedAt:at,startedAt:at,url});
 try {
  fs.mkdirSync(path.join(root,'docs/data'),{recursive:true});fs.writeFileSync(path.join(root,'docs/data/latest.json'),JSON.stringify(latest));
  const s=await new Collector(root,cfg,{clock:()=>t,read}).run(),p=path.join(root,'docs/data/openings/events',e.slug+'.json'),stored=JSON.parse(fs.readFileSync(p));
  const quote=stored.markets.a.quotes[0];assert.equal(quote.modelRank,1);assert.equal(quote.depth.bids.length,2);assert.ok(stored.forecasts[quote.forecastId]);assert.ok(stored.feeAssumptions[quote.feeAssumptionId]);
  assert.equal(s.events[0].markets[0].first.depth,undefined);assert.equal(s.events[0].forecasts,undefined);assert.ok(fs.existsSync(path.join(root,'docs/data/openings/timing.json')));
  const next=await new Collector(root,cfg,{clock:()=>t+5*O.MIN,read:async u=>({...await read(u),receivedAt:new Date(t+5*O.MIN).toISOString()})}).run();assert.equal(next.events[0].markets[0].samples,2);assert.equal(Object.keys(JSON.parse(fs.readFileSync(p)).forecasts).length,1);
 }finally{fs.rmSync(root,{recursive:true,force:true});}
});
