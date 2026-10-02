'use strict';
const C = require('../consistency/core.js');
const ZONES = Object.freeze({KNYC:'America/New_York',KMIA:'America/New_York',KMDW:'America/Chicago',KLAX:'America/Los_Angeles',KSFO:'America/Los_Angeles'});
const MIN = 60000;
function localParts(now, station) {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-CA',{timeZone:ZONES[station],year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hourCycle:'h23'}).formatToParts(new Date(now)).map(x=>[x.type,x.value]));
  return {date:`${p.year}-${p.month}-${p.day}`,hour:Number(p.hour)+Number(p.minute)/60};
}
function addDay(date, n=1) {return C.iso(Date.parse(date+'T12:00:00Z')+n*86400000).slice(0,10);}
function phase(event, now) {
  const p=localParts(now,event.station);
  return p.date<event.date?'TOMORROW':p.date===event.date&&p.hour<10?'TODAY':'COMPLETE';
}
function localInstant(date, hour, station) {
  // Resolve wall time via the zone, including DST. The checkpoints never use the
  // distinct NWS standard-time climate-day boundary to relabel a contract.
  let ms=Date.parse(`${date}T${String(hour).padStart(2,'0')}:00:00Z`);
  for(let i=0;i<3;i++) {
    const p=localParts(ms,station);
    const wall=Date.parse(p.date+'T00:00:00Z')+p.hour*3600000;
    ms += Date.parse(date+'T00:00:00Z')+hour*3600000-wall;
  }
  return ms;
}
function samplingDue(event, now) {
  if(phase(event,now)==='COMPLETE') {
    const p=localParts(now,event.station);
    // One terminal observation at/just after 10 AM; the normal 15-minute
    // interval must not suppress this final checkpoint.
    if(p.date!==event.date||p.hour>=10+20/60)return false;
    return !event.lastSampleAt||Date.parse(event.lastSampleAt)<localInstant(event.date,10,event.station);
  }
  const warm=!event.firstQuoteAt || now-Date.parse(event.firstQuoteAt)<=65*MIN ||
    Object.values(event.markets||{}).some(m=>!m.firstQuoteAt || now-Date.parse(m.firstQuoteAt)<=65*MIN);
  return !event.lastSampleAt || now-Date.parse(event.lastSampleAt)>=(warm?4:14)*MIN;
}
function price(px) {
  if(px==null)return null;
  if(px.currency!=='USD')throw new Error('Unverified currency');
  const u=C.units(px.value);if(u>C.U)throw new Error('Invalid price');return u;
}
function parseQuote(payload, slug, receivedAt, transport={}) {
  const b=payload?.marketData;
  if(!b||b.marketSlug!==slug||!Array.isArray(b.bids)||!Array.isArray(b.offers))throw new Error('Unexpected book schema or market identity');
  const levels=(rows,sign)=>rows.map(r=>{const p=price(r.px),q=Number(r.qty);if(p==null||!Number.isFinite(q)||q<0||q>1e10)throw new Error('Invalid quote depth');return {p,q};}).filter(r=>r.q>0).sort((a,b)=>sign*(a.p-b.p));
  const bids=levels(b.bids,-1),asks=levels(b.offers,1),bid=bids[0],ask=asks[0];
  const asOf=Date.parse(b.transactTime),at=Date.parse(receivedAt),issues=[];
  if(!Number.isFinite(asOf))issues.push('SOURCE_TIME_MISSING');
  else if(asOf>at+1000)issues.push('SOURCE_TIME_IN_FUTURE');
  if(b.state!=='MARKET_STATE_OPEN')issues.push('BOOK_NOT_OPEN');
  if(bid&&ask&&bid.p>=ask.p)issues.push('CROSSED_OR_LOCKED_BOOK');
  if(transport.httpAge!=null&&Number(transport.httpAge)>60)issues.push('HTTP_CACHE_OLD');
  if(!bid&&!ask)issues.push('EMPTY_BOOK');
  return {at:receivedAt,asOf:Number.isFinite(asOf)?C.iso(asOf):null,
    sourceAgeSeconds:Number.isFinite(asOf)?Math.max(0,(at-asOf)/1000):null,
    // transactTime is preserved as the source's update time. A quiet book's old
    // update timestamp alone does not mean a newly fetched book is cached.
    yesBid:bid?.p??null,yesAsk:ask?.p??null,yesBidQty:bid?.q??null,yesAskQty:ask?.q??null,
    noBid:ask?C.U-ask.p:null,noAsk:bid?C.U-bid.p:null,noBidQty:ask?.q??null,noAskQty:bid?.q??null,
    midpoint:bid&&ask?(bid.p+ask.p)/2:null,spread:bid&&ask?ask.p-bid.p:null,
    lastTrade:price(b.stats?.lastTradePx),lastTradeAt:b.stats?.lastTradeSetTime||null,
    providerOpen:price(b.stats?.openPx),providerOpenAt:b.stats?.openSetTime||null,
    sharesTraded:b.stats?.sharesTraded??null,bookState:b.state,usable:issues.length===0,issues,transport};
}
function checkpoint(market, target, toleranceMinutes, now) {
  if(!target)return {status:'NO_BASELINE',targetAt:null,quote:null};
  const ms=Date.parse(target),rows=(market.quotes||[]).filter(q=>q.usable&&Date.parse(q.at)>=ms&&Date.parse(q.at)<=ms+toleranceMinutes*MIN);
  const q=rows[0]||null;
  return {status:q?'RECORDED':now<ms?'PENDING':now<=ms+toleranceMinutes*MIN?'AWAITING_SAMPLE':'MISSING',targetAt:target,at:q?.at??null,delayMinutes:q?+( (Date.parse(q.at)-ms)/MIN).toFixed(2):null,quote:q};
}
function summarizeMarket(m,event,now) {
  const first=m.quotes.find(q=>q.usable)||null,last=m.quotes.at(-1)||null,valid=m.quotes.filter(q=>q.usable);
  const checkpoints={};
  for(const n of [5,15,30,60])checkpoints['plus'+n]=checkpoint(m,m.firstQuoteAt?C.iso(Date.parse(m.firstQuoteAt)+n*MIN):null,10,now);
  for(const h of [0,7,10])checkpoints['local'+h]=checkpoint(m,C.iso(localInstant(event.date,h,event.station)),h===10?20:20,now);
  const mids=valid.map(q=>q.midpoint).filter(Number.isFinite);
  return {...Object.fromEntries(Object.entries(m).filter(([k])=>k!=='quotes')),samples:m.quotes.length,usableSamples:valid.length,first,last,
    midpointChange:first?.midpoint!=null&&last?.usable&&last.midpoint!=null?last.midpoint-first.midpoint:null,
    midpointLow:mids.length?Math.min(...mids):null,midpointHigh:mids.length?Math.max(...mids):null,checkpoints};
}
function summarizeEvent(e,now) {
  return {...Object.fromEntries(Object.entries(e).filter(([k])=>k!=='markets')),phase:phase(e,now),
    file:`events/${e.slug}.json`,markets:Object.values(e.markets).map(m=>summarizeMarket(m,e,now)).sort((a,b)=>(a.band.low??-Infinity)-(b.band.low??-Infinity))};
}
module.exports={ZONES,MIN,localParts,addDay,phase,localInstant,samplingDue,parseQuote,checkpoint,summarizeMarket,summarizeEvent};
