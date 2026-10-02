'use strict';
const C=require('../consistency/core.js'),O=require('./core.js');
const WINDOWS=[['0–15 min',0,15],['15–30 min',15,30],['30–60 min',30,60],['1–2 hours',60,120],['2–4 hours',120,240],['4–8 hours',240,480],['8+ hours',480,Infinity]];
const mean=xs=>xs.length?xs.reduce((a,b)=>a+b,0)/xs.length:null;
function timing(at,event,market) {
  const t=Date.parse(at),p=O.localParts(t,event.station);
  const anchor=Date.parse(market.firstQuoteAt||'');
  return {localDate:p.date,localHour:p.hour,minutesSinceFirstQuote:Number.isFinite(anchor)?(t-anchor)/O.MIN:null,
    minutesSinceFirstListing:(t-Date.parse(market.firstSeenAt||event.firstSeenAt))/O.MIN,
    minutesToContractMidnight:(O.localInstant(event.date,0,event.station)-t)/O.MIN};
}
function captureForecast(latest,event,at,maxAgeMinutes=90) {
  const t=Date.parse(at),ran=Date.parse(latest?.ranAt),s=latest?.stations?.find(s=>s.station===event.station);
  if(!Number.isFinite(ran))return {status:'NO_FORECAST'};
  if(ran>t)return {status:'FUTURE_FORECAST_REJECTED'};
  if(t-ran>maxAgeMinutes*O.MIN)return {status:'FORECAST_TOO_OLD',ranAt:latest.ranAt};
  if(!s||s.stale||s.error)return {status:'STATION_FORECAST_UNAVAILABLE',ranAt:latest.ranAt};
  const horizon=['today','tomorrow'].find(k=>s[k]?.date===event.date),f=s[horizon];
  if(!horizon)return {status:'CONTRACT_DATE_NOT_IN_FORECAST',ranAt:latest.ranAt};
  const buckets=f.buckets;
  if(!Array.isArray(buckets)||!buckets.length||buckets.some(b=>!Number.isInteger(b.f)||!Number.isFinite(b.p)||b.p<0||b.p>1)||new Set(buckets.map(b=>b.f)).size!==buckets.length||Math.abs(buckets.reduce((n,b)=>n+b.p,0)-1)>0.02)return {status:'INVALID_FORECAST_DISTRIBUTION'};
  const snapshot=JSON.parse(JSON.stringify({station:s.station,date:f.date,ranAt:latest.ranAt,horizon,modelVersion:s.modelVersion||latest.meta?.modelVersion||null,
    point:f.point,modal:f.modal,sigma:f.sigma,conf:f.conf,i50:f.i50,i80:f.i80,peakH:f.peakH,
    buckets,models:f.models||[],conditions:f.conditions||null,pointBase:f.pointBase,regimeAdj:f.regimeAdj}));
  const id=C.hash(snapshot);
  return {status:'RECORDED',id,snapshot,ageMinutes:(t-ran)/O.MIN};
}
function bandProbabilities(snapshot,markets) {
  const ps=markets.map(m=>({slug:m.slug,p:snapshot.buckets.filter(b=>(m.band.low===null||b.f>=m.band.low)&&(m.band.high===null||b.f<=m.band.high)).reduce((n,b)=>n+b.p,0)}));
  return Object.fromEntries(ps.map(x=>[x.slug,{probability:x.p,rank:1+ps.filter(y=>y.p>x.p+1e-10).length}]));
}
function sweep(levels,quantity,side,fee) {
  let left=quantity,gross=0,fees=0;
  for(const {p,q} of levels) {
    const n=Math.min(left,q),price=p/C.U;gross+=n*price;fees+=fee.takerCoefficient*n*price*(1-price);left-=n;if(left<1e-8)break;
  }
  const filled=quantity-left;
  return {requestedQty:quantity,filledQty:filled,complete:left<1e-8,vwapU:filled?gross/filled*C.U:null,grossUsd:gross,
    estimatedFeeUsd:fees,estimatedCashUsd:side==='buy'?gross+fees:gross-fees};
}
function enrichQuote(q,event,market,forecast,probability,cfg) {
  q.researchVersion=1;q.timing=timing(q.at,event,market);q.forecastStatus=forecast.status;
  q.forecastId=forecast.id||null;q.forecastAgeMinutes=forecast.status==='RECORDED'?(Date.parse(q.at)-Date.parse(forecast.snapshot.ranAt))/O.MIN:null;
  q.modelProbability=probability?.probability??null;q.modelRank=probability?.rank??null;
  q.feeAssumptionId=cfg.feeAssumption.id;
  if(q.usable&&q.depth)q.hypotheticalFills={buyYes:{},sellYes:{}};
  if(q.hypotheticalFills)for(const n of cfg.researchQuantities) {
    q.hypotheticalFills.buyYes[n]=sweep(q.depth.asks,n,'buy',cfg.feeAssumption);
    q.hypotheticalFills.sellYes[n]=sweep(q.depth.bids,n,'sell',cfg.feeAssumption);
  }
  return q;
}
function point(q,key,event,market) {return q?{at:q.at,value:q[key],qty:q[key==='yesAsk'?'yesAskQty':'yesBidQty'],...timing(q.at,event,market)}:null;}
function extreme(rows,key,min,event,market) {
  const qs=rows.filter(q=>Number.isFinite(q[key]));if(!qs.length)return null;
  const value=qs.reduce((v,q)=>min?Math.min(v,q[key]):Math.max(v,q[key]),qs[0][key]),hits=qs.filter(q=>q[key]===value);
  return {...point(hits[0],key,event,market),lastAt:hits.at(-1).at,tiedObservations:hits.length};
}
function group(rows,event,market) {
  const asks=rows.filter(q=>Number.isFinite(q.yesAsk)),bids=rows.filter(q=>Number.isFinite(q.yesBid));
  return {observations:rows.length,buyObservations:asks.length,sellObservations:bids.length,
    meanAskU:mean(asks.map(q=>q.yesAsk)),meanBidU:mean(bids.map(q=>q.yesBid)),
    minimumAsk:extreme(rows,'yesAsk',true,event,market),maximumBid:extreme(rows,'yesBid',false,event,market)};
}
function summarizeMarket(m,event,now) {
  const midnight=O.localInstant(event.date,0,event.station);
  const recorded=(m.quotes||[]).filter(q=>Date.parse(q.at)<midnight&&Date.parse(q.at)<=now);
  const rows=recorded.filter(q=>q.usable),firstAsk=rows.find(q=>Number.isFinite(q.yesAsk)),firstBid=rows.find(q=>Number.isFinite(q.yesBid));
  const firstForecast=rows.find(q=>q.forecastStatus==='RECORDED');
  const anchor=Date.parse(m.firstQuoteAt||event.firstQuoteAt||event.firstSeenAt);
  const gaps=recorded.slice(1).map((q,i)=>(Date.parse(q.at)-Date.parse(recorded[i].at))/O.MIN);
  const elapsedWindows=WINDOWS.map(([label,lo,hi])=>({label,...group(rows.filter(q=>{const n=(Date.parse(q.at)-anchor)/O.MIN;return n>=lo&&n<hi;}),event,m)}));
  const clockRows=Array.from({length:24},()=>[]);
  for(const q of rows)clockRows[Math.floor(O.localParts(Date.parse(q.at),event.station).hour)].push(q);
  const clockHours=clockRows.map((qs,hour)=>({hour,...group(qs,event,m)}));
  const maximumBid=extreme(rows,'yesBid',false,event,m),minimumAsk=extreme(rows,'yesAsk',true,event,m);
  // A maximum preceding the buy is never counted as an available exit.
  const laterBids=firstAsk?rows.filter(q=>Date.parse(q.at)>Date.parse(firstAsk.at)):[];
  const maximumBidAfterFirstAsk=extreme(laterBids,'yesBid',false,event,m);
  const hasOpeningForecast=!!firstForecast&&m.capture==='BRACKETED'&&Date.parse(firstForecast.at)-anchor<=20*O.MIN;
  const openingBracketMinutes=m.lastAbsentAt?(Date.parse(m.firstSeenAt)-Date.parse(m.lastAbsentAt))/O.MIN:null;
  return {schemaVersion:1,complete:now>=midnight,contractMidnightAt:C.iso(midnight),observations:recorded.length,usableObservations:rows.length,
    firstAsk:point(firstAsk,'yesAsk',event,m),firstBid:point(firstBid,'yesBid',event,m),minimumAsk,maximumBid,maximumBidAfterFirstAsk,
    firstAskToLaterPeakGrossU:firstAsk&&maximumBidAfterFirstAsk?maximumBidAfterFirstAsk.value-firstAsk.yesAsk:null,
    firstForecastAt:firstForecast?.at||null,firstForecastRank:firstForecast?.modelRank??null,firstForecastProbability:firstForecast?.modelProbability??null,
    hasOpeningForecast,openingBracketMinutes,maxGapMinutes:gaps.length?Math.max(...gaps):null,
    fullDepthObservations:rows.filter(q=>q.depth).length,forecastObservations:rows.filter(q=>q.forecastStatus==='RECORDED').length,
    elapsedWindows,clockHours};
}
function combineDayGroups(events,key,property) {
  const templates=key==='clockHours'?Array.from({length:24},(_,hour)=>({hour})):WINDOWS.map(([label])=>({label}));
  return templates.map((id,i)=>{
    const values=events.map(e=>mean(e.markets.filter(m=>m.research?.hasOpeningForecast&&m.research.firstForecastRank===1).map(m=>m.research[key][i][property]).filter(Number.isFinite))).filter(Number.isFinite);
    return {...id,eventDays:values.length,meanU:mean(values)};
  });
}
function stationReport(summaries,now) {
  return {schemaVersion:1,generatedAt:C.iso(now),units:'Prices are millionths of USD; quantities are contracts.',
    method:'Completed station/event days only. Candidate bands are rank 1 in their first saved forecast, captured within 20 minutes of a bracketed first quote. Each event day receives equal weight. Observed extrema are hindsight descriptions, not a trading rule. No interpolation or reconstructed depth/forecasts.',
    stations:Object.keys(O.ZONES).map(station=>{
      const all=summaries.filter(e=>e.station===station),completed=all.filter(e=>now>=O.localInstant(e.date,0,station));
      const eligible=completed.filter(e=>e.markets.some(m=>m.research?.hasOpeningForecast&&m.research.firstForecastRank===1));
      return {station,timeZone:O.ZONES[station],eventsRecorded:all.length,completedEventDays:completed.length,openingForecastEventDays:eligible.length,
        status:eligible.length>=20?'DESCRIPTIVE_SAMPLE_AVAILABLE':'ACCUMULATING',
        entryByElapsed:combineDayGroups(eligible,'elapsedWindows','meanAskU'),buyByLocalHour:combineDayGroups(eligible,'clockHours','meanAskU'),sellByLocalHour:combineDayGroups(eligible,'clockHours','meanBidU')};
    })};
}
module.exports={WINDOWS,timing,captureForecast,bandProbabilities,sweep,enrichQuote,summarizeMarket,stationReport};
