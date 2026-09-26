'use strict';

const C=require('../consistency/core.js');
const U=C.U;
const STATIONS=Object.freeze({
  KNYC:{tz:'America/New_York'},
  KMIA:{tz:'America/New_York'},
  KMDW:{tz:'America/Chicago'},
  KLAX:{tz:'America/Los_Angeles'},
  KSFO:{tz:'America/Los_Angeles'}
});

const clamp=(x,lo,hi)=>Math.max(lo,Math.min(hi,x));
const round=(x,n=4)=>Number.isFinite(x)?+x.toFixed(n):null;
function validateConfig(c){
  if(!c||c.mode!=='OBSERVE_ONLY')throw new Error('edge tracker is OBSERVE_ONLY only');
  for(const k of ['checkpointLocalHour','checkpointLookbackMinutes','maxConsistencyAgeMinutes','maxForecastAgeMinutes','historyRetentionDays'])
    if(!Number.isInteger(c[k]))throw new Error('invalid integer config '+k);
  if(c.checkpointLocalHour<0||c.checkpointLocalHour>23||c.checkpointLookbackMinutes<5||c.checkpointLookbackMinutes>120)throw new Error('invalid checkpoint settings');
  for(const k of ['modelProbabilityMin','modelProbabilityMax','marketYesEquivalentMin','strongEdgePoints','stressNoPriceBuffer'])
    if(typeof c[k]!=='number'||!Number.isFinite(c[k])||c[k]<0||c[k]>1)throw new Error('invalid probability config '+k);
  if(c.modelProbabilityMin>=c.modelProbabilityMax)throw new Error('model probability range inverted');
  return c;
}
function localParts(input,tz){
  const d=new Date(input);if(!Number.isFinite(+d))return null;
  const p=new Intl.DateTimeFormat('en-US',{timeZone:tz,year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',second:'2-digit',hourCycle:'h23'}).formatToParts(d);
  const g=t=>p.find(x=>x.type===t)?.value;
  return {date:`${g('year')}-${g('month')}-${g('day')}`,minute:+g('hour')*60 + +g('minute') + +g('second')/60,hour:+g('hour')};
}
function normalizeDist(rows,kind){
  if(!Array.isArray(rows)||!rows.length)return null;
  const seen=new Set(),out=[];let total=0;
  for(const x of rows){
    const f=Number(x?.f),p=Number(x?.p);if(!Number.isInteger(f)||!Number.isFinite(p)||p<0||p>1||seen.has(f))return null;
    seen.add(f);out.push({f,p});total+=p;
  }
  out.sort((a,b)=>a.f-b.f);
  return {kind,rows:out,total};
}
function distFromForecast(today){
  return normalizeDist(today?.buckets,'FULL_BUCKETS')||normalizeDist(today?.top,'TOP_ONLY');
}
function distFromHistory(row){
  return normalizeDist(row?.buckets,'FULL_BUCKETS')||normalizeDist(row?.top,'TOP_ONLY');
}
function inBand(f,b){return (b.low==null||f>=b.low)&&(b.high==null||f<=b.high);}
function bandProbability(dist,b){
  if(!dist||!b)return {p:null,complete:false,reason:'NO_MODEL_DISTRIBUTION'};
  if(dist.kind==='FULL_BUCKETS'){
    const p=dist.rows.filter(x=>inBand(x.f,b)).reduce((s,x)=>s+x.p,0);
    return {p:clamp(p,0,1),complete:true,reason:null};
  }
  // The old history only retained the seven displayed bars. A bounded band can
  // still be exact when every integer it contains is present. Open tails cannot.
  if(b.low==null||b.high==null)return {p:null,complete:false,reason:'LEGACY_TOP_CANNOT_PRICE_OPEN_TAIL'};
  let p=0;for(let f=b.low;f<=b.high;f++){
    const x=dist.rows.find(y=>y.f===f);if(!x)return {p:null,complete:false,reason:'LEGACY_TOP_MISSING_BAND_DEGREE'};p+=x.p;
  }
  return {p:clamp(p,0,1),complete:true,reason:null};
}
function marketBand(m){
  const s=String(m?.label||'').trim();let x;
  if(x=s.match(/^<=\s*(-?\d+)\s*F$/i))return {low:null,high:+x[1]};
  if(x=s.match(/^>=\s*(-?\d+)\s*F$/i))return {low:+x[1],high:null};
  if(x=s.match(/^(-?\d+)\s*-\s*(-?\d+)\s*F$/i))return {low:+x[1],high:+x[2]};
  if(x=s.match(/^(-?\d+)\s*F$/i))return {low:+x[1],high:+x[1]};
  return null;
}
function modelCohort(p,cfg){return Number.isFinite(p)&&p>=cfg.modelProbabilityMin&&p<=cfg.modelProbabilityMax;}
function feeForOne(priceU,consistencyCfg){return C.feeUpperU([{qty:1,priceU}],String(consistencyCfg.feeCoefficient));}
function economics(modelP,noAskU,consistencyCfg,bufferU=0){
  if(!Number.isFinite(modelP)||!Number.isInteger(noAskU)||noAskU<=0||noAskU>=U)return null;
  const px=noAskU+bufferU;if(px<=0||px>=U)return null;
  const feeU=feeForOne(px,consistencyCfg),costU=px+feeU;
  const expectedPayoutU=Math.round((1-modelP)*U),expectedProfitU=expectedPayoutU-costU;
  return {noAskU:px,feeU,costU,expectedPayoutU,expectedProfitU,expectedRoi:costU?expectedProfitU/costU:null,
    winProfitU:U-costU,lossU:-costU,winReturn:costU?(U-costU)/costU:null};
}
function classifyComparison({checkpointP,currentP,book,consistencyCfg,cfg}){
  if(!modelCohort(checkpointP,cfg))return {status:'OUTSIDE_10AM_COHORT'};
  if(!book)return {status:'NO_BOOK'};
  if(book.valid!==true)return {status:'BOOK_NOT_FRESH',reasons:book.issues||[]};
  if(!Number.isInteger(book.noAsk)||book.noAsk<=0||book.noAsk>=U||!(book.noQty>=1))return {status:'NO_EXECUTABLE_NO_DEPTH'};
  const marketYes=1-book.noAsk/U;
  if(marketYes+1e-12<cfg.marketYesEquivalentMin)return {status:'MARKET_YES_BELOW_THRESHOLD',marketYes};
  if(!Number.isFinite(currentP))return {status:'CURRENT_MODEL_BAND_INCOMPLETE',marketYes};
  if(currentP>cfg.modelProbabilityMax)return {status:'CURRENT_MODEL_NO_LONGER_LOW',marketYes,edge:marketYes-currentP};
  const edge=marketYes-currentP,raw=economics(currentP,book.noAsk,consistencyCfg,0);
  if(!(edge>0))return {status:'MARKET_NOT_RICHER_THAN_MODEL',marketYes,edge,raw};
  if(!raw||!(raw.expectedProfitU>0))return {status:'FEE_NEGATIVE',marketYes,edge,raw};
  const bufferU=Math.round(cfg.stressNoPriceBuffer*U),stress=economics(currentP,book.noAsk,consistencyCfg,bufferU);
  const strong=edge+1e-12>=cfg.strongEdgePoints&&stress&&stress.expectedProfitU>0;
  return {status:strong?'STRONG_RESEARCH_LEAD':'RESEARCH_LEAD',marketYes,edge,raw,stress};
}
function findHistoryCheckpoint(rows,station,date,cfg){
  const tz=STATIONS[station]?.tz;if(!tz)return null;const cutoff=cfg.checkpointLocalHour*60;
  const a=(rows||[]).filter(r=>r?.st===station&&r?.date===date&&r?.at).map(r=>({r,lp:localParts(r.at,tz)}))
    .filter(x=>x.lp&&x.lp.date===date&&x.lp.minute<=cutoff&&x.lp.minute>=cutoff-cfg.checkpointLookbackMinutes)
    .sort((a,b)=>Date.parse(a.r.at)-Date.parse(b.r.at));
  if(!a.length)return null;const r=a[a.length-1].r,dist=distFromHistory(r);if(!dist)return null;
  return {station,date,at:r.at,point:r.point??null,distribution:dist,source:dist.kind==='FULL_BUCKETS'?'HISTORY_FULL_BUCKETS':'LEGACY_HISTORY_TOP_ONLY'};
}
function capturePreCutoff(state,forecast,cfg){
  state.preCutoff=state.preCutoff&&typeof state.preCutoff==='object'?state.preCutoff:{};
  for(const s of forecast?.stations||[]){
    if(s?.error||s?.stale||!STATIONS[s.station]||!s.today?.date||!forecast.ranAt)continue;const lp=localParts(forecast.ranAt,STATIONS[s.station].tz);if(!lp||lp.date!==s.today.date)continue;
    const cutoff=cfg.checkpointLocalHour*60;if(lp.minute>cutoff||lp.minute<cutoff-cfg.checkpointLookbackMinutes)continue;
    const dist=distFromForecast(s.today);if(!dist)continue;const key=s.station+'|'+s.today.date,old=state.preCutoff[key];
    if(!old||Date.parse(forecast.ranAt)>Date.parse(old.at))state.preCutoff[key]={station:s.station,date:s.today.date,at:forecast.ranAt,point:s.today.point??null,distribution:dist,source:'LIVE_PRE10_FULL_BUCKETS'};
  }
}
function freezeCheckpoints(state,forecast,historyRows,now,cfg){
  state.checkpoints=state.checkpoints&&typeof state.checkpoints==='object'?state.checkpoints:{};capturePreCutoff(state,forecast,cfg);
  const stationDates=new Map();for(const s of forecast?.stations||[])if(STATIONS[s.station]&&s.today?.date)stationDates.set(s.station,s.today.date);
  for(const [station,date] of stationDates){
    const key=station+'|'+date;if(state.checkpoints[key])continue;const lp=localParts(now,STATIONS[station].tz);if(!lp||lp.date!==date||lp.minute<cfg.checkpointLocalHour*60)continue;
    const cached=state.preCutoff[key];const cp=cached||findHistoryCheckpoint(historyRows,station,date,cfg);if(cp)state.checkpoints[key]=cp;
  }
}
function currentDist(forecast,station,date){const s=(forecast?.stations||[]).find(x=>x.station===station&&x.today?.date===date);return s&&!s.error&&!s.stale?distFromForecast(s.today):null;}
function compareMarkets(state,forecast,consistency,historyRows,now,cfg){
  freezeCheckpoints(state,forecast,historyRows,now,cfg);const results=[];
  const consistencyCfg=consistency?.settings||{};
  for(const m of consistency?.markets||[]){
    if(m.metric!=='high'||!m.valid||!m.active||!STATIONS[m.station]||!m.date)continue;const key=m.station+'|'+m.date,cp=state.checkpoints[key];if(!cp)continue;
    const b=marketBand(m);if(!b)continue;const p10=bandProbability(cp.distribution,b);if(!p10.complete||!modelCohort(p10.p,cfg))continue;
    const cur=bandProbability(currentDist(forecast,m.station,m.date),b);const cls=classifyComparison({checkpointP:p10.p,currentP:cur.complete?cur.p:null,book:m.book,consistencyCfg,cfg});
    results.push({id:m.slug,station:m.station,date:m.date,eventSlug:m.eventSlug,label:m.label,url:m.url,checkpointAt:cp.at,checkpointSource:cp.source,
      checkpointP:round(p10.p),currentP:cur.complete?round(cur.p):null,currentReason:cur.reason||null,
      yesAsk:m.book?.yesAsk==null?null:m.book.yesAsk/U,noAsk:m.book?.noAsk==null?null:m.book.noAsk/U,
      yesQty:m.book?.yesQty??0,noQty:m.book?.noQty??0,bookValid:m.book?.valid===true,bookIssues:m.book?.issues||[],bookAsOf:m.book?.asOf||null,bookReceivedAt:m.book?.receivedAt||null,
      status:cls.status,marketYesEquivalent:round(cls.marketYes),edge:round(cls.edge),raw:cls.raw||null,stress:cls.stress||null});
  }
  return results.sort((a,b)=>((b.edge??-9)-(a.edge??-9))||a.station.localeCompare(b.station)||a.label.localeCompare(b.label));
}
function updateEntries(state,comparisons,now){
  state.entries=state.entries&&typeof state.entries==='object'?state.entries:{};const added=[];
  for(const r of comparisons){if(!['RESEARCH_LEAD','STRONG_RESEARCH_LEAD'].includes(r.status))continue;const key=r.station+'|'+r.date+'|'+r.id;
    const old=state.entries[key];if(!old){state.entries[key]={key,station:r.station,date:r.date,marketSlug:r.id,label:r.label,url:r.url,firstSeenAt:C.iso(now),checkpointAt:r.checkpointAt,
      checkpointP:r.checkpointP,currentP:r.currentP,marketYesEquivalent:r.marketYesEquivalent,edge:r.edge,noAsk:r.noAsk,feeU:r.raw?.feeU??null,costU:r.raw?.costU??null,statusAtEntry:r.status,
      bestEdge:r.edge,lastSeenAt:C.iso(now),observations:1,settled:false};added.push(key);}else{old.lastSeenAt=C.iso(now);old.observations=(old.observations||0)+1;if((r.edge??-9)>(old.bestEdge??-9))old.bestEdge=r.edge;}
  }
  return added;
}
function settleEntries(state,cli){const settledNow=[];for(const e of Object.values(state.entries||{})){if(e.settled)continue;const actual=cli?.[e.station]?.[e.date]?.max;if(!Number.isFinite(actual))continue;const b=marketBand({label:e.label});if(!b)continue;const hit=inBand(actual,b),payoutU=hit?0:U,costU=e.costU??null;e.settled=true;e.actual=actual;e.bandHit=hit;e.settledAt=cli[e.station][e.date].firstSeen||new Date().toISOString();e.hypotheticalPnlU=costU==null?null:payoutU-costU;settledNow.push(e.key);}return settledNow;}
function calibration(historyRows,cli,cfg){
  const by={};for(const r of historyRows||[]){if(!r?.st||!r?.date||!r?.at||!Number.isFinite(cli?.[r.st]?.[r.date]?.max)||!STATIONS[r.st])continue;const lp=localParts(r.at,STATIONS[r.st].tz),cutoff=cfg.checkpointLocalHour*60;if(!lp||lp.date!==r.date||lp.minute>cutoff||lp.minute<cutoff-cfg.checkpointLookbackMinutes)continue;const k=r.st+'|'+r.date;if(!by[k]||Date.parse(r.at)>Date.parse(by[k].at))by[k]=r;}
  const ranges=[[.01,.02],[.02,.04],[.04,.06],[.06,.08],[.08,.10]],bins=ranges.map(([lo,hi])=>({lo,hi,n:0,hits:0,sumP:0}));let stationDays=0,total=0,hits=0;
  for(const r of Object.values(by)){stationDays++;const actual=cli[r.st][r.date].max;for(const x of r.top||[]){if(!modelCohort(x.p,cfg))continue;total++;if(x.f===actual)hits++;const b=bins.find(q=>x.p>=q.lo&&x.p<q.hi||(q.hi===.10&&x.p===.10));if(b){b.n++;b.sumP+=x.p;if(x.f===actual)b.hits++;}}}
  return {stationDays,total,hits,actualRate:total?hits/total:null,bins:bins.map(b=>({...b,stated:b.n?b.sumP/b.n:null,actual:b.n?b.hits/b.n:null}))};
}
function entryStats(entries){const settled=Object.values(entries||{}).filter(e=>e.settled&&Number.isFinite(e.hypotheticalPnlU)&&Number.isFinite(e.costU));const cost=settled.reduce((s,e)=>s+e.costU,0),pnl=settled.reduce((s,e)=>s+e.hypotheticalPnlU,0),wins=settled.filter(e=>!e.bandHit).length;return {settled: settled.length,wins,losses:settled.length-wins,costU:cost,pnlU:pnl,roi:cost?pnl/cost:null};}
module.exports={U,STATIONS,validateConfig,localParts,normalizeDist,distFromForecast,distFromHistory,inBand,bandProbability,marketBand,modelCohort,economics,classifyComparison,
  findHistoryCheckpoint,capturePreCutoff,freezeCheckpoints,currentDist,compareMarkets,updateEntries,settleEntries,calibration,entryStats};
