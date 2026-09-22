'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const C=require('../scripts/shadow/core'),{Collector}=require('../scripts/shadow/collector');
const cfg=require('../scripts/shadow/config.json'),{audit}=require('./audit-shadow');
for(const [wording,expected] of [
 ['less than or equal to 62F',{low:null,high:62}],['greater than or equal to 80F',{low:80,high:null}],
 ['less than 64F',{low:null,high:63}],['greater than 65F',{low:66,high:null}],
 ['≤ 63°F',{low:null,high:63}],['≥ 66°F',{low:66,high:null}],
 ['< 0F',{low:null,high:-1}],['below -5F',{low:null,high:-6}],
 ['at most 72 Fahrenheit',{low:null,high:72}],['at least 72F',{low:72,high:null}],
 ['between -5F and -4F',{low:-5,high:-4}],['2026-09-22 between 64F and 65F',{low:64,high:65}]
])test('explicit boundary: '+wording,()=>assert.deepEqual(C.parseBand(wording),expected));
test('conflicting bounds, decimals and unrelated dates remain unsupported',()=>{
 for(const s of ['between 64F and 65F or less than 61F','less than or equal to 63.5F','2026-09-22','66F with no range'])assert.equal(C.parseBand(s),null,s);
});
for(const f of require('./fixtures/shadow-audit-bands.json'))test('recorded tail wording parses: '+f.slug,()=>assert(C.parseBand(f.rules)));
test('fresh receipt does NOT bypass old source timestamp; diagnostic keeps both clocks',()=>{
 const n=Date.parse('2026-09-22T19:00:00Z');const p={marketData:{marketSlug:'test',bids:[{px:{currency:'USD',value:'0.05'},qty:'100'}],offers:[],state:'MARKET_STATE_OPEN',transactTime:C.iso(n-600000)}};
 const b=C.parseBook(p,'test',n,120,{httpDate:C.iso(n),httpAge:'0'});
 assert.equal(b.valid,false);assert(b.onlySourceAgeBlocked);assert.equal(b.sourceAgeSeconds,600);assert.equal(b.transport.httpAge,'0');
});
test('discovery balances stations at a cap and persists omitted market details',async()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'shadow-coverage-')),now=Date.parse('2026-09-22T20:00:00Z');
 const events=cfg.stations.map(st=>({slug:'event-'+st.toLowerCase(),closed:false,description:'',markets:[0,1,2].map(i=>({slug:'m-'+st.toLowerCase()+'-'+i,question:`Will the highest temperature at ${st} for 2026-09-22 as reported by the NWS Daily Climate Report be between ${60+i*2}F and ${61+i*2}F?`,active:true,closed:false,outcomes:['Yes','No']}))}));
 try {const co=new Collector(root,{...cfg,maxMarketsPerCycle:5},{clock:()=>now,read:async()=>({data:{events},receivedAt:C.iso(now)})});
 await co.discover();assert.equal(new Set(co.markets.map(m=>m.station)).size,5);assert.equal(co.state.discovery.complete,false);
 assert(co.state.discovery.coverage.every(g=>g.watched===1&&g.omitted.length===2));
 }finally{fs.rmSync(root,{recursive:true,force:true});}
});
test('discovery failures back off instead of retrying blocked search every minute',async()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'shadow-backoff-'));let now=Date.parse('2026-09-22T20:00:00Z'),calls=0;
 try {const co=new Collector(root,cfg,{clock:()=>now,read:async()=>{calls++;throw Error('HTTP 403');}});
 await co.discover();now+=60000;await co.discover();assert.equal(calls,1);assert(co.errors.some(x=>x.includes('retry paused')));
 }finally{fs.rmSync(root,{recursive:true,force:true});}
});
test('audit treats empty NO offers separately from stale book blocker',()=>{
 const m={slug:'s',station:'KNYC',date:'2026-09-22',valid:true,band:{low:64,high:65},rules:'between 64F and 65F'};
 const r=audit([{at:'2026-09-22T20:00:00Z',kind:'MARKET_RULES',markets:[m]},
 {at:'2026-09-22T20:01:00Z',kind:'BOOK',market:'s',noAsks:[]},
 {at:'2026-09-22T20:01:00Z',kind:'MARKET_OBSERVATION',market:'s',station:'KNYC',date:'2026-09-22',floorF:66,status:'BOOK_UNUSABLE'}].map(JSON.stringify).join('\n'));
 assert.equal(r.originallyParsedEliminatedChecks,1);assert.equal(r.originallyParsedEliminatedChecksWithEmptyNoBook,1);
});
