'use strict';
const C=require('./core.js');
const {U,units,iso,hash}=C;
/** Fail-closed parsing of the documented public affirmative (YES) instrument. */
function parseBook(payload,slug,receivedAt,cfg,transport={}) {
  const b=payload?.marketData;
  if(!b||b.marketSlug!==slug||!Array.isArray(b.bids)||!Array.isArray(b.offers))throw new Error('Unexpected book schema or wrong market slug');
  const asOf=Date.parse(b.transactTime);
  if(!Number.isFinite(asOf))throw new Error('Missing/invalid transactTime');
  function levels(rows,ascending) {
    const seen=new Set();
    const r=rows.map(x=>{
      if(!x.px||x.px.currency!=='USD')throw new Error('Unverified book currency');
      const p=units(x.px.value),s=String(x.qty),q=Number(s);
      if(p<0||p>U||!/^\d+(?:\.\d+)?$/.test(s)||!Number.isFinite(q)||q>1e9)throw new Error('Invalid book price or quantity');
      if(seen.has(p))throw new Error('Duplicate aggregated price level');seen.add(p);
      // Whole contracts only; fractional depth is never rounded upward.
      return {priceU:p,qty:Math.floor(q)};
    }).filter(x=>x.qty>0&&x.priceU>0&&x.priceU<U).sort((a,b)=>ascending?a.priceU-b.priceU:b.priceU-a.priceU);
    return {all:r.length,rows:r.slice(0,cfg.maxDepthLevels)};
  }
  const bi=levels(b.bids,false),of=levels(b.offers,true);
  const bids=bi.rows,offers=of.rows;
  const issues=[];
  if(b.state!=='MARKET_STATE_OPEN')issues.push('BOOK_NOT_OPEN');
  if(bids.length&&offers.length&&bids[0].priceU>=offers[0].priceU)issues.push('CROSSED_OR_LOCKED_BOOK');
  if(asOf>receivedAt)issues.push('BOOK_SOURCE_TIME_IN_FUTURE');
  if(receivedAt-asOf>cfg.maxBookSourceAgeSeconds*1000)issues.push('BOOK_SOURCE_TIME_TOO_OLD');
  if(transport.httpAge!=null&&Number(transport.httpAge)>cfg.maxBookSourceAgeSeconds)issues.push('HTTP_CACHE_AGE_TOO_OLD');
  return {slug,receivedAt:iso(receivedAt),asOf:iso(asOf),state:b.state,valid:!issues.length,issues,bids,offers,
    yesAsks:offers,noAsks:bids.map(x=>({priceU:U-x.priceU,qty:x.qty})),
    hash:hash({bids,offers,state:b.state,asOf:b.transactTime}),transport,
    truncated:bi.all>bids.length||of.all>offers.length,
    timeSemantics:'transactTime semantics are not independently established; strict source-age checks remain in force'};
}
function bookSetIssues(relation,books,now,cfg) {
  const issues=[],receipts=[],sources=[];
  for(const leg of relation.legs) {
    const b=books[leg.slug];
    if(!b){issues.push('BOOK_MISSING');continue;}
    issues.push(...b.issues);
    const r=Date.parse(b.receivedAt),s=Date.parse(b.asOf);
    if(!Number.isFinite(r)||!Number.isFinite(s)){issues.push('INVALID_QUOTE_TIME');continue;}
    receipts.push(r);sources.push(s);
    if(r>now||s>now)issues.push('QUOTE_TIME_IN_FUTURE');
    if(now-r>cfg.maxBookReceiptAgeSeconds*1000)issues.push('BOOK_RECEIPT_TOO_OLD');
    if(now-s>cfg.maxBookSourceAgeSeconds*1000)issues.push('BOOK_SOURCE_TIME_TOO_OLD');
    if(!(leg.side==='YES'?b.yesAsks:b.noAsks).length)issues.push(leg.side==='YES'?'NO_YES_ASK_DEPTH':'NO_NO_ASK_DEPTH');
  }
  if(receipts.length&&Math.max(...receipts)-Math.min(...receipts)>cfg.maxBookReceiptSkewSeconds*1000)issues.push('LEGS_RECEIVED_TOO_FAR_APART');
  if(sources.length&&Math.max(...sources)-Math.min(...sources)>cfg.maxBookSourceSkewSeconds*1000)issues.push('SOURCE_TIMESTAMPS_TOO_FAR_APART');
  return [...new Set(issues)];
}
function sharedDepth(a,b) {
  const first=new Map(a.map(x=>[x.priceU,x.qty]));
  return b.map(x=>({priceU:x.priceU,qty:Math.min(x.qty,first.get(x.priceU)||0)})).filter(x=>x.qty>0);
}
function fillDepth(levels,qty,buffer=0,percent=100) {
  let left=qty;const fills=[];
  for(const r of levels){
    const p=r.priceU+buffer,n=Math.min(left,Math.floor(r.qty*percent/100));
    if(p<=0||p>=U||n<=0)continue;
    fills.push({priceU:p,displayedPriceU:r.priceU,qty:n});left-=n;if(!left)break;
  }
  return left?null:fills;
}
/** Equal complete basket counts on all legs. No collateral/netting assumption.
 * Each alternative is evaluated alone; depth/cost estimates MUST NOT be summed.
 */
function sizeBasket(relation,markets,books,cfg,{stress=false,previous=null}={}) {
  const byId=new Map(markets.map(m=>[m.slug,m]));
  const inputs=relation.legs.map(l=>{
    const b=books[l.slug],cur=l.side==='YES'?b.yesAsks:b.noAsks;
    const prev=previous?.[l.slug];
    return {...l,minimumQty:Math.ceil(byId.get(l.slug).minimumQty),
      levels:stress?(prev?sharedDepth(l.side==='YES'?prev.yesAsks:prev.noAsks,cur):[]):cur};
  });
  const minQ=Math.max(1,...inputs.map(l=>l.minimumQty));
  const percent=stress?cfg.stressDepthPercent:100,buffer=stress?units(cfg.adversePricePerLeg):0;
  const maxCost=units(cfg.maxHypotheticalBasketCost),minSurplus=units(cfg.minNetSurplusPerBundle);
  let best=null,indicative=null,sized=0;
  for(let qty=minQ;qty<=cfg.maxBundles;qty++) {
    const legs=[];let available=true;
    for(const l of inputs){
      const fills=fillDepth(l.levels,qty,buffer,percent);
      if(!fills){available=false;break;}
      const notionalU=fills.reduce((s,f)=>s+f.qty*f.priceU,0),feeU=C.feeUpperU(fills,cfg.feeCoefficient);
      legs.push({slug:l.slug,side:l.side,label:l.label,fills,notionalU,feeU,costU:notionalU+feeU,averagePrice:notionalU/U/qty});
    }
    if(!available)break;
    const notionalU=legs.reduce((s,l)=>s+l.notionalU,0),feeU=legs.reduce((s,l)=>s+l.feeU,0),costU=notionalU+feeU;
    const minimumPayoutU=qty*relation.proof.minimumU,minimumSurplusU=minimumPayoutU-costU;
    const result={bundles:qty,legs,notionalU,feeU,costU,minimumPayoutU,minimumSurplusU,minimumReturn:minimumSurplusU/costU,
      surplusPerBundleU:minimumSurplusU/qty,
      largestSingleLegCostU:Math.max(...legs.map(l=>l.costU)),
      maxFullCostAtRiskIfRelationshipFailsU:costU,
      feeModel:'Exact taker formula rounded UP per leg to cents (conservative cumulative-fee cap estimate)',
      stress,assumption:stress?'Depth shared at identical prices in two snapshots, reduced and price-buffered; NOT a fill':'Displayed book-depth calculation only; NOT a fill'};
    if(!indicative)indicative=result;
    if(costU>maxCost)break;
    sized++;
    if(minimumSurplusU>=minSurplus*qty && result.minimumReturn>=cfg.minNetReturn && (!best||minimumSurplusU>best.minimumSurplusU))best=result;
  }
  const reason=best?null:!indicative?'INSUFFICIENT_MATCHED_WHOLE_CONTRACT_DEPTH':!sized?'HYPOTHETICAL_COST_CAP':'NO_NET_SURPLUS_AT_REQUIRED_THRESHOLD';
  return {best,indicative,reason};
}
function evaluateRelation(relation,markets,books,now,cfg,previous=null) {
  const byId=new Map(markets.map(m=>[m.slug,m])),ruleHashes={};
  const reasons=[];
  for(const l of relation.legs){const m=byId.get(l.slug);ruleHashes[l.slug]=m?.rulesHash;
    if(!m?.valid)reasons.push('RULES_REVIEW');
    if(!m?.active)reasons.push('MARKET_INACTIVE');
    if(m?.rulesChanged)reasons.push('RULES_CHANGED_REVIEW');
    if(!m||now-Date.parse(m.checkedAt)>cfg.maxRuleAgeSeconds*1000||Date.parse(m.checkedAt)>now)reasons.push('RULE_METADATA_STALE');
  }
  const fi=C.feeIssue(cfg,now);if(fi)reasons.push(fi);
  reasons.push(...bookSetIssues(relation,books,now,cfg));
  const base={...relation,at:iso(now),ruleHashes,reasons:[...new Set(reasons)],displayed:null,stress:null,indicative:null,confirmation:null};
  if(reasons.length)return {...base,status:'BLOCKED'};
  const displayed=sizeBasket(relation,markets,books,cfg);
  base.displayed=displayed.best;base.indicative=displayed.indicative;
  if(!displayed.best)return {...base,status:'NO_NET_EDGE',reasons:[displayed.reason]};
  if(!previous)return {...base,status:'FIRST_SNAPSHOT_ONLY',reasons:['WAITING_FOR_LATER_INDEPENDENT_REQUEST']};
  if(JSON.stringify(ruleHashes)!==JSON.stringify(previous.ruleHashes))return {...base,status:'FIRST_SNAPSHOT_ONLY',reasons:['RULES_DIFFER_BETWEEN_SNAPSHOTS']};
  const previousIssues=bookSetIssues(relation,previous.books,previous.at,cfg);
  if(previousIssues.length)return {...base,status:'FIRST_SNAPSHOT_ONLY',reasons:['PREVIOUS_SNAPSHOT_UNUSABLE',...previousIssues]};
  const gaps=[];
  for(const l of relation.legs){
    const b=books[l.slug],p=previous.books[l.slug];
    const gap=Date.parse(b.receivedAt)-Date.parse(p.receivedAt);gaps.push(gap);
    if(gap<cfg.confirmationDelaySeconds*1000)reasons.push('CONFIRMATION_TOO_SOON');
    if(gap>cfg.maxConfirmationGapSeconds*1000)reasons.push('CONFIRMATION_GAP_TOO_LONG');
    if(Date.parse(b.transport?.startedAt)<=Date.parse(p.receivedAt)||!b.transport?.startedAt)reasons.push('REQUESTS_NOT_INDEPENDENT');
    if(Date.parse(b.asOf)<Date.parse(p.asOf))reasons.push('BOOK_SOURCE_TIME_REGRESSED');
  }
  base.confirmation={firstAt:iso(previous.at),secondAt:iso(now),minLegGapSeconds:Math.min(...gaps)/1000,maxLegGapSeconds:Math.max(...gaps)/1000};
  if(reasons.length)return {...base,status:'FIRST_SNAPSHOT_ONLY',reasons:[...new Set(reasons)]};
  const stress=sizeBasket(relation,markets,books,cfg,{stress:true,previous:previous.books});
  base.stress=stress.best;
  return {...base,status:stress.best?'TWO_SNAPSHOT_CANDIDATE':'DID_NOT_SURVIVE_STRESS',reasons:stress.best?[]:[stress.reason]};
}
module.exports={parseBook,bookSetIssues,sharedDepth,fillDepth,sizeBasket,evaluateRelation};
