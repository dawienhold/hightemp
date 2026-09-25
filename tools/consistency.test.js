'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path'),zlib=require('node:zlib');
const C=require('../scripts/consistency/core.js'),B=require('../scripts/consistency/books.js'),D=require('../scripts/consistency/collector.js');
const BASE=require('../scripts/consistency/config.json');
const NOW=Date.parse('2026-09-23T17:00:00Z');
const cfg=x=>({...JSON.parse(JSON.stringify(BASE)),...x});
const event=()=>({slug:'temp-nychigh-2026-09-23',title:'Highest temperature in New York City on September 23?',description:'Highest temperature in New York City on September 23?',closed:false});
function rawMarket(slug,predicate,extra={}){return {slug,question:event().title,description:`Will the highest temperature recorded at Central Park (KNYC) in New York City for 2026-09-23 as reported by the National Weather Service's Climatological Report (Daily) be ${predicate}? Outcome verified from NWS Climatological Report.`,
  active:true,closed:false,status:'MARKET_STATUS_OPEN',outcomes:['Yes','No'],minimumTradeQty:0.01,feeCoefficient:0.0695,...extra};}
const parsed=(slug,pred,extra={},ev=event(),config=cfg())=>C.parseMarket(rawMarket(slug,pred,extra),ev,NOW,config);
const pair=()=>[parsed('lower','greater than 65F'),parsed('higher','greater than 67F')];
function relation(ms=pair(),sides=['YES','NO']){const legs=ms.map((m,i)=>({slug:m.slug,side:sides[i],label:m.label}));return {id:'test',familyKey:ms[0].familyKey,eventSlug:ms[0].eventSlug,station:'KNYC',date:'2026-09-23',type:'IMPLICATION_OR_EQUIVALENCE',legs,proof:C.payoffProof(ms,legs)};}
function payload(slug,yesBid=.40,yesAsk=.43,qty=1000,at=NOW){return {marketData:{marketSlug:slug,state:'MARKET_STATE_OPEN',transactTime:C.iso(at),
  bids:[{px:{value:yesBid,currency:'USD'},qty:String(qty)}],offers:[{px:{value:yesAsk,currency:'USD'},qty:String(qty)}]}};}
function book(slug,bid,ask,at=NOW,qty=1000){return B.parseBook(payload(slug,bid,ask,qty,at),slug,at,cfg(),{startedAt:C.iso(at-100),receivedAt:C.iso(at)});}
function books(at=NOW,qty=1000){return {lower:book('lower',.40,.43,at,qty),higher:book('higher',.50,.55,at,qty)};}
const evaluated=(opts={})=>B.evaluateRelation(opts.rel||relation(opts.ms||pair()),opts.ms||pair(),opts.books||books(),opts.now||NOW,opts.cfg||cfg(),opts.previous||null);
const validPredicates=[['between 64F and 65F',64,65],['less than or equal to 63F',null,63],['greater than or equal to 66F',66,null],['less than 64F',null,63],['greater than 65F',66,null],['at most 63 F',null,63],['at least 66 degrees Fahrenheit',66,null],['63F or lower',null,63],['66F or above',66,null],['<=63F',null,63],['>=66F',66,null],['-5F to -3F',-5,-3],['between -5F and -3F',-5,-3],['exactly 64F',64,64],['64F',64,64]];
for(const [s,low,high] of validPredicates)test('predicate: '+s,()=>assert.deepEqual(C.parsePredicate(s),{low,high}));
for(const s of ['64C','64.5F','between 65F and 64F','between 64F and 65F or 68F','not less than 64F','64F unless it rains','100000F'])test('reject predicate: '+s,()=>assert.equal(C.parsePredicate(s),null));
test('config has no live mode',()=>assert.throws(()=>C.validateConfig(cfg({mode:'LIVE'}))));
test('config excludes other venues',()=>assert.throws(()=>C.validateConfig(cfg({venue:'KALSHI'}))));
test('config bounds workload',()=>assert.throws(()=>C.validateConfig(cfg({concurrency:50}))));
test('USD integer arithmetic rejects exponents/negatives',()=>{assert.equal(C.units('0.0695'),69500);for(const s of ['-1','1e-2','0.1234567','bad'])assert.throws(()=>C.units(s));});
test('banker cap is conservatively rounded up per leg',()=>assert.equal(C.feeUpperU([{priceU:500000,qty:100}],'0.0695'),1740000));
test('fees symmetric',()=>assert.equal(C.feeUpperU([{priceU:100000,qty:100}],'0.0695'),C.feeUpperU([{priceU:900000,qty:100}],'0.0695')));
test('fee review expires',()=>assert.equal(C.feeIssue(cfg(),NOW+31*86400000),'FEE_REVIEW_OVERDUE'));
test('future-dated fee review rejected at evaluation',()=>assert.equal(C.feeIssue(cfg({feeReviewedOn:'2027-01-01'}),NOW),'FEE_REVIEW_DATE_IN_FUTURE'));
test('audited weather description parses',()=>{const m=parsed('a','between 64F and 65F');assert.equal(m.valid,true,m.issues.join());assert.deepEqual(m.band,{low:64,high:65});});
test('slug cannot decide the band',()=>assert.equal(parsed('tc-lt999f','between 64F and 65F').band.high,65));
test('unknown legal suffix fails closed',()=>assert.equal(parsed('a','between 64F and 65F',{description:rawMarket('a','between 64F and 65F').description+' Unless canceled.'}).valid,false));
test('reversed outcomes rejected',()=>assert.equal(parsed('a','64F',{outcomes:['No','Yes']}).valid,false));
test('contradictory long side rejected despite outcomes',()=>assert.equal(parsed('a','64F',{marketSides:[{long:true,description:'No'},{long:false,description:'Yes'}]}).valid,false));
test('explicit YES long sides without outcomes accepted',()=>assert.equal(parsed('a','64F',{outcomes:null,marketSides:[{long:true,description:'Yes'},{long:false,description:'No'}]}).valid,true));
test('fee mismatch rejected',()=>assert.ok(parsed('a','64F',{feeCoefficient:.15}).issues.includes('MARKET_FEE_DIFFERS_REVIEW')));
test('extra fallback provisions require review',()=>assert.ok(parsed('a','64F',{rulesDisclaimer:'If unavailable use another source'}).issues.includes('EXTRA_SETTLEMENT_TERMS_REVIEW')));
test('event alternate source requires review',()=>assert.equal(parsed('a','64F',{}, {...event(),resolutionSource:'Wunderground'}).valid,false));
test('invalid calendar day rejected',()=>{const m=rawMarket('a','64F');m.description=m.description.replace('2026-09-23','2026-02-30');assert.equal(C.parseMarket(m,event(),NOW,cfg()).valid,false);});
test('low temperature excluded by default',()=>{const m=rawMarket('a','64F');m.description=m.description.replace('highest','lowest');m.question='Lowest temperature?';assert.equal(C.parseMarket(m,event(),NOW,cfg()).valid,false);});
test('same event and same template share family',()=>assert.equal(pair()[0].familyKey,pair()[1].familyKey));
test('different event never automatically linked',()=>assert.notEqual(parsed('a','64F').familyKey,parsed('b','65F',{}, {...event(),slug:'another-event'}).familyKey));
test('different close time separates family',()=>assert.notEqual(parsed('a','64F',{endDate:'2026-09-24T12:00:00Z'}).familyKey,parsed('b','65F',{endDate:'2026-09-24T13:00:00Z'}).familyKey));
test('different source/date/station not inferred from same city',()=>{const m=rawMarket('x','64F');m.description=m.description.replace('KNYC','KMIA');const p=C.parseMarket(m,event(),NOW,cfg());assert.notEqual(p.familyKey,parsed('a','64F').familyKey);});
test('nested thresholds minimum payout is $1',()=>{const r=relation();assert.equal(r.proof.minimumU,C.U);assert.equal(r.proof.maximumU,2*C.U);});
test('wrong direction of nested pair has zero floor',()=>{const ms=pair();const p=C.payoffProof(ms,[{slug:'lower',side:'NO'},{slug:'higher',side:'YES'}]);assert.equal(p.minimumU,0);});
test('disjoint NO pair minimum payout is $1',()=>{const ms=[parsed('a','between 64F and 65F'),parsed('b','between 66F and 67F')];assert.equal(relation(ms,['NO','NO']).proof.minimumU,C.U);});
test('overlapping NO pair is not a hedge',()=>{const ms=[parsed('a','between 64F and 66F'),parsed('b','between 66F and 67F')];assert.equal(relation(ms,['NO','NO']).proof.minimumU,0);});
test('two ordinary YES bands have zero floor outside bands',()=>{const ms=[parsed('a','between 64F and 65F'),parsed('b','between 66F and 67F')];assert.equal(relation(ms,['YES','YES']).proof.minimumU,0);});
test('complete YES partition covers both unbounded tails',()=>{const ms=[parsed('a','at most 63F'),parsed('b','between 64F and 65F'),parsed('c','at least 66F')];const p=C.payoffProof(ms,ms.map(m=>({slug:m.slug,side:'YES'})));assert.equal(p.minimumU,C.U);assert.equal(p.maximumU,C.U);});
test('missing one-degree hole blocks all-YES floor',()=>{const ms=[parsed('a','less than 64F'),parsed('b','between 65F and 66F'),parsed('c','at least 67F')];assert.equal(C.payoffProof(ms,ms.map(m=>({slug:m.slug,side:'YES'}))).minimumU,0);});
test('all NO on n-way partition pays n-1',()=>{const ms=[parsed('a','at most 63F'),parsed('b','between 64F and 65F'),parsed('c','at least 66F')];assert.equal(C.payoffProof(ms,ms.map(m=>({slug:m.slug,side:'NO'}))).minimumU,2*C.U);});
test('duplicate market legs rejected',()=>assert.throws(()=>C.payoffProof(pair(),[{slug:'lower',side:'YES'},{slug:'lower',side:'NO'}])));
test('mismatched rule families cannot be proved together',()=>{const ms=[pair()[0],parsed('higher','greater than 67F',{}, {...event(),slug:'other'})];assert.throws(()=>relation(ms));});
test('enumerated proof agrees with brute force for random interval pairs',()=>{
  let seed=12345;const rnd=()=>{seed=(seed*1664525+1013904223)>>>0;return seed%21-10;};
  for(let k=0;k<300;k++){const a=[rnd(),rnd()].sort((x,y)=>x-y),b=[rnd(),rnd()].sort((x,y)=>x-y);
    const ms=[parsed('a',`between ${a[0]}F and ${a[1]}F`),parsed('b',`between ${b[0]}F and ${b[1]}F`)];
    if(k%3===0)ms[0].band.low=null;if(k%5===0)ms[1].band.high=null;
    for(const sa of ['YES','NO'])for(const sb of ['YES','NO']){const p=relation(ms,[sa,sb]).proof;const values=[];
      for(let t=-30;t<=30;t++)values.push(ms.reduce((sum,m,i)=>sum+((([sa,sb][i]==='YES')===C.yesAt(m,t))?C.U:0),0));
      assert.equal(p.minimumU,Math.min(...values));assert.equal(p.maximumU,Math.max(...values));}
  }
});
test('complete partition diagnostics detect gaps',()=>{const ms=[parsed('a','at most 63F'),parsed('b','at least 65F')];assert.deepEqual(C.relations(ms,cfg()).groups[0].gaps,['64 F']);});
test('relation generator excludes zero-floor combinations',()=>assert.ok(C.relations(pair(),cfg()).relations.every(x=>x.proof.minimumU>0)));
test('YES buys use offers and NO buys use complement of bids',()=>{const b=book('a',.40,.43);assert.equal(b.yesAsks[0].priceU,430000);assert.equal(b.noAsks[0].priceU,600000);});
test('empty bids do not become NO offers from YES asks',()=>{const p=payload('a');p.marketData.bids=[];const b=B.parseBook(p,'a',NOW,cfg());assert.equal(b.noAsks.length,0);});
test('wrong book slug rejected',()=>assert.throws(()=>B.parseBook(payload('x'),'a',NOW,cfg())));
test('missing currency rejected',()=>{const p=payload('a');delete p.marketData.bids[0].px.currency;assert.throws(()=>B.parseBook(p,'a',NOW,cfg()));});
test('missing transactTime rejected',()=>{const p=payload('a');delete p.marketData.transactTime;assert.throws(()=>B.parseBook(p,'a',NOW,cfg()));});
test('duplicate aggregate levels rejected',()=>{const p=payload('a');p.marketData.bids.push(p.marketData.bids[0]);assert.throws(()=>B.parseBook(p,'a',NOW,cfg()));});
test('locked/crossed book blocked',()=>assert.ok(book('a',.50,.49).issues.includes('CROSSED_OR_LOCKED_BOOK')));
test('future source time blocked',()=>assert.ok(B.parseBook(payload('a',.4,.43,1000,NOW+1000),'a',NOW,cfg()).issues.includes('BOOK_SOURCE_TIME_IN_FUTURE')));
test('old source time blocked',()=>assert.ok(B.parseBook(payload('a',.4,.43,1000,NOW-121000),'a',NOW,cfg()).issues.includes('BOOK_SOURCE_TIME_TOO_OLD')));
test('fractional quantities rounded down',()=>assert.equal(book('a',.4,.43,NOW,1.9).yesAsks[0].qty,1));
test('shared depth uses smaller quantity at identical prices',()=>assert.deepEqual(B.sharedDepth([{priceU:4,qty:10}],[{priceU:4,qty:6},{priceU:5,qty:8}]),[{priceU:4,qty:6}]));
test('depth walker includes all levels required for equal quantity',()=>{const f=B.fillDepth([{priceU:400000,qty:2},{priceU:500000,qty:5}],4);assert.deepEqual(f.map(x=>x.qty),[2,2]);});
test('missing full leg depth rejects basket',()=>assert.equal(B.fillDepth([{priceU:400000,qty:2}],3),null));
test('stress prices at $1 are excluded, not profitable',()=>assert.equal(B.fillDepth([{priceU:990000,qty:50}],1,10000,50),null));
test('only first snapshot never marked confirmed',()=>assert.equal(evaluated().status,'FIRST_SNAPSHOT_ONLY'));
test('two snapshots survive fees, equal sizing and stress',()=>{const first=evaluated();const now=NOW+12000;const r=evaluated({books:books(now),now,previous:{at:NOW,books:books(),ruleHashes:first.ruleHashes}});assert.equal(r.status,'TWO_SNAPSHOT_CANDIDATE',JSON.stringify(r.reasons));assert.ok(r.stress.minimumSurplusU>0);assert.ok(r.stress.costU<=C.units('100'));assert.equal(r.stress.legs[0].fills.reduce((a,b)=>a+b.qty,0),r.stress.legs[1].fills.reduce((a,b)=>a+b.qty,0));});
test('confirmation must be a new request',()=>{const now=NOW+12000,bs=books(now);bs.lower.transport.startedAt=C.iso(NOW-1);const r=evaluated({books:bs,now,previous:{at:NOW,books:books(),ruleHashes:evaluated().ruleHashes}});assert.ok(r.reasons.includes('REQUESTS_NOT_INDEPENDENT'));});
test('slow leg receipt skew blocked',()=>{const bs=books();bs.lower.receivedAt=C.iso(NOW-9000);assert.ok(evaluated({books:bs}).reasons.includes('LEGS_RECEIVED_TOO_FAR_APART'));});
test('old cached receipt blocked despite fresh source time',()=>{const bs=books();bs.lower.receivedAt=C.iso(NOW-30000);assert.ok(evaluated({books:bs}).reasons.includes('BOOK_RECEIPT_TOO_OLD'));});
test('long confirmation gap is not survival',()=>{const now=NOW+160000;const r=evaluated({books:books(now),now,ms:pair().map(m=>({...m,checkedAt:C.iso(now)})),previous:{at:NOW,books:books(),ruleHashes:evaluated().ruleHashes}});assert.ok(r.reasons.includes('CONFIRMATION_GAP_TOO_LONG'));});
test('fee review blocks candidates but keeps diagnostics',()=>assert.ok(evaluated({cfg:cfg({feeReviewedOn:'2026-01-01'})}).reasons.includes('FEE_REVIEW_OVERDUE')));
test('rule changes block regardless of good prices',()=>assert.ok(evaluated({ms:pair().map(m=>({...m,rulesChanged:true}))}).reasons.includes('RULES_CHANGED_REVIEW')));
test('inactive market blocked',()=>assert.ok(evaluated({ms:pair().map(m=>({...m,active:false}))}).reasons.includes('MARKET_INACTIVE')));
test('fee-only false edge rejected',()=>{const bs={lower:book('lower',.47,.49),higher:book('higher',.50,.52)};const r=evaluated({books:bs});assert.equal(r.status,'NO_NET_EDGE');});
test('cheap top level is not used for unavailable deep size',()=>{const r=evaluated({books:books(NOW,2)});assert.ok(r.displayed.bundles<=2);});
test('depth haircut can remove minimum size',()=>{const first=evaluated({books:books(NOW,1)}),now=NOW+12000;const r=evaluated({books:books(now,1),now,previous:{at:NOW,books:books(NOW,1),ruleHashes:first.ruleHashes}});assert.equal(r.status,'DID_NOT_SURVIVE_STRESS');});
for(const url of ['http://gateway.polymarket.us/v1/search','https://api.polymarket.us/v1/orders','https://gateway.polymarket.us/v1/orders','https://evil.example/v1/search','https://u:p@gateway.polymarket.us/v1/search','https://gateway.polymarket.us:444/v1/search','https://gateway.polymarket.us/v1/search?api_key=abc'])test('network allowlist rejects '+url,()=>assert.throws(()=>D.allowedURL(url)));
test('public book URL allowed',()=>assert.equal(D.allowedURL('https://gateway.polymarket.us/v1/markets/a/book').hostname,'gateway.polymarket.us'));
test('transport always unsigned GET, rejects redirects, no order support',async()=>{let opt;const read=D.createClient(cfg(),{transport:async(u,o)=>{opt=o;return {ok:true,status:200,headers:{get:()=>null},text:async()=>'{}'};},clock:()=>NOW,wait:async()=>{}});await read('https://gateway.polymarket.us/v1/search');assert.equal(opt.method,'GET');assert.equal(opt.redirect,'error');assert.equal(Object.keys(opt.headers).some(x=>/auth|key/i.test(x)),false);});
test('403 stops without bypass or retry',async()=>{let n=0;const read=D.createClient(cfg(),{transport:async()=>{n++;return {ok:false,status:403};},clock:()=>NOW,wait:async()=>{}});await assert.rejects(read('https://gateway.polymarket.us/v1/search'));assert.equal(n,1);});
function mockRunner(root,{disappear=false,fail=false,changeRules=false}={}) {
  let t=NOW,bookPass=0,eventReads=0;
  const clock=()=>t;
  const e={...event(),markets:[rawMarket('lower','greater than 65F'),rawMarket('higher','greater than 67F')]};
  async function read(url){D.allowedURL(url);t+=150;const u=new URL(url);let data;
    if(fail)throw new Error('Synthetic provider failure');
    if(u.pathname==='/v1/search')data={events:[e]};
    else if(u.pathname.includes('/events/')){eventReads++;data={event:JSON.parse(JSON.stringify(e))};if(changeRules&&eventReads>1)data.event.markets[0].description+=' Revised terms.';}
    else {const s=u.pathname.split('/')[3];bookPass++;data=payload(s,s==='lower'?.4:.5,s==='lower'?.43:.55,1000,t);if(disappear&&bookPass>2){data.marketData.bids=[];data.marketData.offers=[];}}
    return {data,startedAt:C.iso(t-50),receivedAt:C.iso(t),durationMs:50};
  }
  return new D.Collector(root,cfg(),{read,clock,wait:async ms=>{t+=ms;}});
}
function tempRoot(){return fs.mkdtempSync(path.join(os.tmpdir(),'consistency-'));}
test('mock end-to-end run records a two-snapshot candidate',async()=>{const root=tempRoot();try{const s=await mockRunner(root).run();assert.ok(s.summary.twoSnapshotCandidateBaskets>0,JSON.stringify(s.errors));assert.equal(s.mode,'OBSERVE_ONLY');const file=path.join(root,'docs/data/consistency/history/2026-09-23.jsonl.gz');assert.ok(zlib.gunzipSync(fs.readFileSync(file)).toString().includes('BOOK_SNAPSHOT'));}finally{fs.rmSync(root,{recursive:true,force:true});}});
test('vanished first-snapshot edge is logged, not called a fill',async()=>{const root=tempRoot();try{const s=await mockRunner(root,{disappear:true}).run();assert.equal(s.summary.twoSnapshotCandidateBaskets,0);assert.ok(s.candidates.some(x=>x.status==='FIRST_EDGE_DISAPPEARED'));}finally{fs.rmSync(root,{recursive:true,force:true});}});
test('changed rules on second read are not confirmed',async()=>{const root=tempRoot();try{const s=await mockRunner(root,{changeRules:true}).run();assert.equal(s.summary.twoSnapshotCandidateBaskets,0);assert.ok(s.candidates.some(x=>x.reasons.includes('RELATION_REMOVED_OR_RULES_CHANGED_ON_RECHECK')));}finally{fs.rmSync(root,{recursive:true,force:true});}});
test('provider outage writes diagnostics, never synthetic success',async()=>{const root=tempRoot();try{const s=await mockRunner(root,{fail:true}).run();assert.equal(s.summary.twoSnapshotCandidateBaskets,0);assert.ok(s.errors.length);assert.equal(s.health,'CHECK_PROVIDER_OR_RULE_DIAGNOSTICS');}finally{fs.rmSync(root,{recursive:true,force:true});}});
test('existing temperature/shadow/MLB state remains byte-for-byte intact',async()=>{const root=tempRoot();const files=['docs/data/state.json','docs/data/stats.json','docs/data/latest.json','docs/data/shadow/state.json','docs/data/mlb.json'];try{for(const f of files){fs.mkdirSync(path.dirname(path.join(root,f)),{recursive:true});fs.writeFileSync(path.join(root,f),'KEEP '+f);}await mockRunner(root).run();for(const f of files)assert.equal(fs.readFileSync(path.join(root,f),'utf8'),'KEEP '+f);}finally{fs.rmSync(root,{recursive:true,force:true});}});
test('corrupt consistency state is never silently reset',()=>{const root=tempRoot();try{const f=path.join(root,'docs/data/consistency/state.json');fs.mkdirSync(path.dirname(f),{recursive:true});fs.writeFileSync(f,'broken');assert.throws(()=>mockRunner(root));assert.equal(fs.readFileSync(f,'utf8'),'broken');}finally{fs.rmSync(root,{recursive:true,force:true});}});
test('restart preserves episode history without inventing trades',async()=>{const root=tempRoot();try{await mockRunner(root).run();const s=await mockRunner(root).run();assert.equal(s.counts.runs,2);assert.ok(s.recentEpisodes.some(x=>x.observations>=2));assert.equal(Object.hasOwn(s,'positions'),false);}finally{fs.rmSync(root,{recursive:true,force:true});}});
module.exports={cfg,event,rawMarket,parsed,pair,relation,payload,book,books,mockRunner,NOW};
const archivedRules=require('./fixtures/consistency-archived-rules.json');
for(const r of archivedRules.records)test('archived descriptor compatibility: '+r.slug,()=>{
  // Side metadata is synthetic here: the archive contains normalized descriptions,
  // not a complete raw market API response. No live access or market status is implied.
  const m=C.parseMarket({slug:r.slug,question:r.question,description:r.description,outcomes:['Yes','No'],
    active:true,closed:false,minimumTradeQty:0.01,feeCoefficient:0.0695},r.event,NOW,cfg());
  assert.equal(m.valid,true,m.issues.join(','));assert.equal(m.station,r.station);assert.equal(m.date,r.date);
  if(r.priorParsedBand)assert.deepEqual(m.band,r.priorParsedBand);
});
test('unbounded numeric cell has an honest label',()=>assert.equal(C.bandLabel({low:null,high:null}),'All integer temperatures'));

test('event-level exceptional settlement wording needs review',()=>assert.ok(parsed('a','64F',{}, {...event(),description:'If CLI data is unavailable, use an alternative source.'}).issues.includes('EXTRA_SETTLEMENT_TERMS_REVIEW')));
