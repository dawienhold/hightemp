'use strict';
/** Pure, read-only research logic. All prices/costs are integer microdollars.
 * No weather forecasts, settlement assumptions from prices, or order functions.
 */
const { createHash } = require('node:crypto');
const U = 1_000_000;
const STATIONS = Object.freeze({
  KNYC: { name: 'Central Park', offset: -5 },
  KMIA: { name: 'Miami International', offset: -5 },
  KMDW: { name: 'Chicago Midway', offset: -6 },
  KLAX: { name: 'Los Angeles International', offset: -8 },
  KSFO: { name: 'San Francisco International', offset: -8 }
});
const iso = x => new Date(x).toISOString();
const hash = x => createHash('sha256').update(typeof x === 'string' ? x : JSON.stringify(x)).digest('hex');
const finite = x => typeof x === 'number' && Number.isFinite(x);
const slugOK = x => typeof x === 'string' && /^[a-z0-9][a-z0-9-]{0,199}$/.test(x);
function units(x) {
  const s = String(x);
  if (!/^\d+(?:\.\d{1,6})?$/.test(s)) throw new Error('Expected a nonnegative decimal with at most six places');
  const [a,b=''] = s.split('.'); const n = Number(a)*U + Number(b.padEnd(6,'0'));
  if (!Number.isSafeInteger(n)) throw new Error('Money outside safe integer range');
  return n;
}
const usd = x => x/U;
function day(ms, station) { return iso(ms + STATIONS[station].offset*3600000).slice(0,10); }
function validDate(x) {
  return typeof x === 'string' && /^20\d{2}-\d{2}-\d{2}$/.test(x) &&
    finite(Date.parse(x+'T00:00:00Z')) && iso(Date.parse(x+'T00:00:00Z')).slice(0,10)===x;
}
function text(x) {
  return String(x??'').replace(/&nbsp;/gi,' ').replace(/&deg;|&#176;/gi,' degrees ')
    .replace(/&le;|&#8804;|\u2264/gi,'<=').replace(/&ge;|&#8805;|\u2265/gi,'>=')
    .replace(/&lt;/gi,'<').replace(/&gt;/gi,'>').replace(/&#39;|&apos;|\u2019/gi,"'")
    .replace(/\u00b0/g,' degrees ').replace(/[\u2010-\u2015\u2212]/g,'-').replace(/\s+/g,' ').trim();
}
function validateConfig(c) {
  if(c.mode!=='OBSERVE_ONLY'||c.venue!=='POLYMARKET_US') throw new Error('Only OBSERVE_ONLY / POLYMARKET_US is supported; no live mode exists');
  if(typeof c.enabled!=='boolean') throw new Error('enabled must be boolean');
  if(!Array.isArray(c.stations)||!c.stations.length||c.stations.some(s=>!STATIONS[s])||new Set(c.stations).size!==c.stations.length) throw new Error('Invalid stations');
  if(!Array.isArray(c.metrics)||!c.metrics.length||c.metrics.some(x=>!['high','low'].includes(x))) throw new Error('Invalid metrics');
  if(!Array.isArray(c.searchQueries)||c.searchQueries.length>3||c.searchQueries.some(x=>!['highest temperature','lowest temperature'].includes(x))) throw new Error('Only weather discovery is supported');
  if(!Array.isArray(c.eventSlugs)||c.eventSlugs.length>20||c.eventSlugs.some(x=>!slugOK(x))) throw new Error('Invalid event slugs');
  const ranges={searchPageSize:[1,100],searchMaxPages:[1,6],maxEvents:[1,20],maxMarketsPerEvent:[2,16],maxRelationsPerGroup:[1,600],
    requestTimeoutSeconds:[2,15],requestSpacingMs:[250,2000],concurrency:[1,4],maxRunSeconds:[20,240],
    maxBookSourceAgeSeconds:[1,300],maxBookReceiptAgeSeconds:[1,60],maxBookReceiptSkewSeconds:[1,15],maxBookSourceSkewSeconds:[1,300],
    confirmationDelaySeconds:[2,30],maxConfirmationGapSeconds:[5,180],maxRuleAgeSeconds:[5,180],maxDepthLevels:[1,50],maxBundles:[1,500],
    stressDepthPercent:[1,100],feeReviewAfterDays:[1,30],recentEpisodesLimit:[10,300]};
  for(const [k,[lo,hi]] of Object.entries(ranges)) if(!Number.isInteger(c[k])||c[k]<lo||c[k]>hi) throw new Error('Invalid configuration: '+k);
  for(const k of ['maxHypotheticalBasketCost','minNetSurplusPerBundle','adversePricePerLeg','feeCoefficient']) units(c[k]);
  if(units(c.maxHypotheticalBasketCost)<=0||units(c.maxHypotheticalBasketCost)>10000*U||units(c.adversePricePerLeg)>=U||units(c.feeCoefficient)>U) throw new Error('Invalid cost or fee settings');
  if(!finite(c.minNetReturn)||c.minNetReturn<0||c.minNetReturn>1) throw new Error('Invalid minimum return');
  if(!validDate(c.feeReviewedOn)) throw new Error('Invalid fee review date');
  if(!c.approvedRuleChanges||typeof c.approvedRuleChanges!=='object'||Array.isArray(c.approvedRuleChanges)) throw new Error('Invalid approvedRuleChanges');
  for(const [s,h] of Object.entries(c.approvedRuleChanges)) if(!slugOK(s)||!/^[a-f0-9]{64}$/.test(h)) throw new Error('Invalid explicit rules approval');
  return c;
}
function feeIssue(cfg, now) {
  const reviewed=Date.parse(cfg.feeReviewedOn+'T00:00:00Z');
  if(reviewed>now+86400000) return 'FEE_REVIEW_DATE_IN_FUTURE';
  return now-reviewed>cfg.feeReviewAfterDays*86400000?'FEE_REVIEW_OVERDUE':null;
}
/** Conservative upper estimate: exact formula summed per leg, rounded UP to cents.
 * The documented cumulative banker-rounded fee cap is never greater than this.
 * No maker rebates, tier discounts, or cross-position collateral offsets assumed.
 */
function feeUpperU(fills, coefficient) {
  const s=BigInt(U), theta=BigInt(units(coefficient));
  const n=fills.reduce((a,f)=>a+theta*BigInt(f.qty)*BigInt(f.priceU)*(s-BigInt(f.priceU))*100n,0n);
  const d=s*s*s;
  return Number((n+d-1n)/d)*10000;
}
/** CLI is an integer Fahrenheit outcome. Boundaries are taken from explicit text,
 * not URLs, titles, displayed prices, nearby stations, or probability estimates.
 */
function parsePredicate(input) {
  const s=text(input).toLowerCase().replace(/[?.]+$/,'').trim();
  const f='\\s*(?:degrees?\\s*)?f(?:ahrenheit)?';
  let m;
  if(m=s.match(new RegExp('^between\\s+(-?\\d+)'+f+'\\s+and\\s+(-?\\d+)'+f+'$'))) return interval(+m[1],+m[2]);
  if(m=s.match(new RegExp('^(-?\\d+)'+f+'\\s*(?:to|-)\\s*(-?\\d+)'+f+'$'))) return interval(+m[1],+m[2]);
  const ops=[['(?:less than or equal to|at most|no more than|<=)','le'],['(?:greater than or equal to|at least|no less than|>=)','ge'],
    ['(?:less than|below|under|<)','lt'],['(?:greater than|above|over|>)','gt']];
  for(const [p,op] of ops) if(m=s.match(new RegExp('^'+p+'\\s*(-?\\d+)'+f+'$'))) {
    const n=+m[1]; return op==='le'?interval(null,n):op==='lt'?interval(null,n-1):op==='ge'?interval(n,null):interval(n+1,null);
  }
  if(m=s.match(new RegExp('^(-?\\d+)'+f+'\\s+or\\s+(below|lower|less|above|higher|more)$'))) return /below|lower|less/.test(m[2])?interval(null,+m[1]):interval(+m[1],null);
  if(m=s.match(new RegExp('^(?:exactly\\s+)?(-?\\d+)'+f+'$'))) return interval(+m[1],+m[1]);
  return null;
}
function interval(low,high) {
  if([low,high].some(x=>x!==null&&(!Number.isSafeInteger(x)||Math.abs(x)>10000)) || (low!==null&&high!==null&&low>high)) return null;
  return {low,high};
}
function bandLabel(b) {
  if(!b)return 'Unparsed';
  if(b.low===null&&b.high===null)return 'All integer temperatures';
  return b.low===null?'<= '+b.high+' F':b.high===null?'>= '+b.low+' F':b.low===b.high?b.low+' F':b.low+'-'+b.high+' F';
}
function legalExtras(m) {
  const out={};
  for(const k of ['rulesDisclaimer','rules','rulesPrimary','rulesSecondary','resolutionSource','resolutionRules','settlementRules','endDate','settlementDate','settlementTime']) {
    if(m[k]!=null && m[k]!=='') out[k]=typeof m[k]==='string'?text(m[k]):m[k];
  }
  return out;
}
function parseMarket(m,event,now,cfg) {
  m=m||{};event=event||{};
  const issues=[],description=text(m.description), question=text(m.question||m.title);
  // Deliberately narrow audited contract grammar. Unknown clauses FAIL CLOSED.
  const re=/^Will the (highest|lowest|maximum|minimum) temperature recorded at (.{1,180}?) \((K[A-Z]{3})\) in (.{1,100}?) for (20\d{2}-\d{2}-\d{2}) as reported by the National Weather Service(?:'s)? (Climatological Report \(Daily\)|Daily Climate Report) be (.+?)\?\s*Outcome verified from NWS Climatological Report\.?$/i;
  const match=description.match(re);
  let metric=null,station=null,date=null,band=null,skeleton=null;
  if(!match) issues.push('UNSUPPORTED_RULE_TEMPLATE');
  else {
    metric=/highest|maximum/i.test(match[1])?'high':'low'; station=match[3].toUpperCase();date=match[5];band=parsePredicate(match[7]);
    if(!band) issues.push('AMBIGUOUS_OR_UNSUPPORTED_BOUNDARY');
    skeleton=description.replace(match[7],'[PREDICATE]').toLowerCase();
    if(!STATIONS[station]||!cfg.stations.includes(station))issues.push('STATION_OUT_OF_SCOPE');
    if(!validDate(date))issues.push('INVALID_CONTRACT_DATE');
    if(!cfg.metrics.includes(metric))issues.push('METRIC_OUT_OF_SCOPE');
    if(/highest|maximum/i.test(question)&&metric==='low'||/lowest|minimum/i.test(question)&&metric==='high')issues.push('QUESTION_METRIC_CONFLICT');
    const ids=[...new Set((text([question,event.description,event.resolutionSource].join(' ')).match(/\bK[A-Z]{3}\b/g)||[]))];
    if(ids.some(x=>x!==station))issues.push('STATION_TEXT_CONFLICT');
    const descDates=question.match(/\b20\d{2}-\d{2}-\d{2}\b/g)||[];
    if(descDates.some(x=>x!==date))issues.push('QUESTION_DATE_CONFLICT');
    // A question containing an explicit numeric range must not contradict its description.
    const qb=question.match(/\bbe\s+(.+?)\?$/i);
    if(qb) {const p=parsePredicate(qb[1]);if(p&&JSON.stringify(p)!==JSON.stringify(band))issues.push('QUESTION_BOUNDARY_CONFLICT');}
  }
  if(!slugOK(m.slug)||!slugOK(event.slug))issues.push('INVALID_MARKET_OR_EVENT_SLUG');
  let outcomes=m.outcomes;
  if(typeof outcomes==='string'){try{outcomes=JSON.parse(outcomes);}catch{outcomes=null;}}
  const sides=Array.isArray(m.marketSides)?m.marketSides:[];
  const long=sides.filter(x=>x.long===true),short=sides.filter(x=>x.long===false);
  const mapped=long.length===1&&short.length===1&&/^yes$/i.test(text(long[0].description))&&/^no$/i.test(text(short[0].description));
  const ordered=Array.isArray(outcomes)&&outcomes.length===2&&/^yes$/i.test(outcomes[0])&&/^no$/i.test(outcomes[1]);
  if(!mapped&&!ordered)issues.push('YES_NO_ORIENTATION_UNVERIFIED');
  if(sides.length&&!mapped)issues.push('CONTRADICTORY_MARKET_SIDES');
  if(outcomes!=null&&!ordered)issues.push('CONTRADICTORY_OUTCOMES');
  const extras=legalExtras(m);
  // Do not silently model market-specific nonnumeric clauses or alternative data sources.
  if(/weather underground|wunderground|celsius|50\s*\/\s*50|void|cancel|fallback|fair market|unavailable|revis|correct|alternative/i.test(text(JSON.stringify({extras,eventDescription:event.description||'',eventResolutionSource:event.resolutionSource||'',eventRules:event.rulesDisclaimer||''}))))issues.push('EXTRA_SETTLEMENT_TERMS_REVIEW');
  const minimumQty=m.minimumTradeQty==null?1:Number(m.minimumTradeQty);
  if(!finite(minimumQty)||minimumQty<=0||minimumQty>1e7)issues.push('INVALID_MINIMUM_QUANTITY');
  const coefficient=m.feeCoefficient==null?null:String(m.feeCoefficient);
  if(coefficient!=null){try{if(units(coefficient)!==units(cfg.feeCoefficient))issues.push('MARKET_FEE_DIFFERS_REVIEW');}catch{issues.push('UNKNOWN_MARKET_FEE');}}
  const eventTerms={slug:event.slug||'',description:text(event.description),resolutionSource:text(event.resolutionSource),rulesDisclaimer:text(event.rulesDisclaimer),endDate:text(event.endDate)};
  const rulesHash=hash({description,question,outcomes,sides:sides.map(x=>({long:x.long,description:text(x.description)})),extras,eventTerms,minimumQty,coefficient});
  const familyKey=match?hash({venue:cfg.venue,event:eventTerms,metric,station,date,skeleton,extras}):null;
  const active=m.active===true&&m.closed===false&&m.archived!==true&&event.closed!==true&&event.archived!==true&&
    (!m.status||m.status==='MARKET_STATUS_OPEN');
  return {slug:m.slug||'',eventSlug:event.slug||'',title:question,description,rulesHash,familyKey,metric,station,date,band,
    label:bandLabel(band),issues,valid:issues.length===0,active,minimumQty:Number.isFinite(minimumQty)?minimumQty:1,
    feeCoefficient:coefficient,checkedAt:iso(now),eventTerms,extras,
    url:'https://polymarket.us/event/'+encodeURIComponent(event.slug||''),
    settlementCaveat:'Numeric CLI settlement only. Missing-data/fair-market-price settlement can break this payoff relationship.'};
}
/** Prove over ALL integer temperatures, including both unbounded tails.
 * Cells change only at a lower boundary or one past an inclusive upper boundary.
 */
function cells(markets) {
  const cuts=[...new Set(markets.flatMap(m=>[m.band.low,m.band.high===null?null:m.band.high+1]).filter(x=>x!==null))].sort((a,b)=>a-b);
  if(!cuts.length)return [{low:null,high:null,value:0}];
  return [{low:null,high:cuts[0]-1,value:cuts[0]-1},...cuts.map((x,i)=>({low:x,high:i+1<cuts.length?cuts[i+1]-1:null,value:x}))];
}
function yesAt(m,x) {return (m.band.low===null||x>=m.band.low)&&(m.band.high===null||x<=m.band.high);}
function payoffProof(markets,legs) {
  const byId=new Map(markets.map(m=>[m.slug,m]));
  if(!legs.length||new Set(legs.map(l=>l.slug)).size!==legs.length)throw new Error('Duplicate or empty market legs');
  const ms=legs.map(l=>{const m=byId.get(l.slug);if(!m?.valid||!m.band||!['YES','NO'].includes(l.side))throw new Error('Unverified payoff leg');return m;});
  if(new Set(ms.map(m=>m.familyKey)).size!==1)throw new Error('Rules/families do not match');
  const outcomes=cells(ms).map(c=>{const legPayouts=legs.map((l,i)=>(l.side==='YES'?yesAt(ms[i],c.value):!yesAt(ms[i],c.value))?U:0);
    return {...c,label:bandLabel(c),legPayouts,payoutU:legPayouts.reduce((a,b)=>a+b,0)};});
  return {minimumU:Math.min(...outcomes.map(c=>c.payoutU)),maximumU:Math.max(...outcomes.map(c=>c.payoutU)),outcomes,
    scope:'Every integer value of the shared CLI temperature; excludes nonnumeric/fair-market-price settlement and incomplete execution'};
}
function relations(markets,cfg) {
  const groups=new Map();for(const m of markets)if(m.valid){if(!groups.has(m.familyKey))groups.set(m.familyKey,[]);groups.get(m.familyKey).push(m);}
  const out=[],diagnostics=[];
  for(const [key,ms] of groups) {
    const unique=[...new Map(ms.map(m=>[m.slug,m])).values()].sort((a,b)=>a.slug.localeCompare(b.slug));
    const found=new Map();
    const add=(legs,type)=>{const proof=payoffProof(unique,legs);if(proof.minimumU<=0)return;
      const sorted=legs.slice().sort((a,b)=>a.slug.localeCompare(b.slug));const id=hash({family:key,legs:sorted});
      found.set(id,{id,familyKey:key,eventSlug:unique[0].eventSlug,station:unique[0].station,date:unique[0].date,metric:unique[0].metric,type,
        legs:sorted.map(l=>({...l,label:unique.find(m=>m.slug===l.slug).label})),proof:payoffProof(unique,sorted)});};
    for(let i=0;i<unique.length;i++)for(let j=i+1;j<unique.length;j++)for(const a of ['YES','NO'])for(const b of ['YES','NO'])
      add([{slug:unique[i].slug,side:a},{slug:unique[j].slug,side:b}],a==='NO'&&b==='NO'?'EXCLUSIVE_NO_PAIR':a==='YES'&&b==='YES'?'COVERING_YES_PAIR':'IMPLICATION_OR_EQUIVALENCE');
    if(unique.length>2){add(unique.map(m=>({slug:m.slug,side:'YES'})),'ALL_YES_COVER');add(unique.map(m=>({slug:m.slug,side:'NO'})),'MULTI_NO_PAYOFF_FLOOR');}
    const r=[...found.values()].slice(0,cfg.maxRelationsPerGroup);out.push(...r);
    const partitionCells=cells(unique).map(c=>({...c,count:unique.filter(m=>yesAt(m,c.value)).length}));
    diagnostics.push({familyKey:key,eventSlug:unique[0].eventSlug,station:unique[0].station,date:unique[0].date,metric:unique[0].metric,
      markets:unique.length,relationships:r.length,relationshipsOmitted:found.size-r.length,
      completeNumericPartition:partitionCells.every(c=>c.count===1),gaps:partitionCells.filter(c=>c.count===0).map(c=>bandLabel(c)),overlaps:partitionCells.filter(c=>c.count>1).map(c=>bandLabel(c))});
  }
  return {relations:out,groups:diagnostics};
}
module.exports={U,STATIONS,iso,hash,finite,slugOK,units,usd,day,validDate,text,validateConfig,feeIssue,feeUpperU,
  parsePredicate,interval,bandLabel,parseMarket,cells,yesAt,payoffProof,relations};
