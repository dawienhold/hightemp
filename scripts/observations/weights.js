'use strict';
// Prospective, prequential neighbor nowcasting. Not a prediction of the daily CLI high.
const C=require('./core.js');
const mean=a=>a.length?a.reduce((s,x)=>s+x,0)/a.length:null;
const clip=(v,lo,hi)=>Math.max(lo,Math.min(hi,v));
const q=(a,p)=>{const b=[...a].sort((x,y)=>x-y);return b.length?b[Math.min(b.length-1,Math.ceil(p*b.length)-1)]:null;};
const bucket=age=>age<=20?'15':age<=45?'30':'60';
function regime(row,tz) {
  const h=+new Intl.DateTimeFormat('en-US',{timeZone:tz,hour:'2-digit',hourCycle:'h23'}).format(new Date(row.t));
  const wind=row.windDir==null?'unknown':['N','E','S','W'][Math.floor((row.windDir+45)%360/90)];
  return `${row.wet?'wet':'dry'}|${wind}|${h>=9&&h<18?'day':'night'}`;
}
function features(rows,station,now,cfg) {
  const spec=cfg.targets[station];
  const selected=C.selectRows(rows,now);const good=selected.filter(C.usableTemperature);
  const targets=good.filter(r=>r.station===station&&r.precise);
  const anchor=targets.at(-1);
  if(!anchor)return {ok:false,status:'NO_PRECISE_ANCHOR',reason:'No raw tenth-C target anchor yet. Structured/coarse readings remain visible but do not establish an exact anchor.',inputs:[],neighborDiagnostics:spec.neighbors.map(id=>({station:id,status:'WAITING_FOR_TARGET_ANCHOR'}))};
  const age=(now-C.ms(anchor.t))/60000;
  if(age<5)return {ok:false,status:'FRESH_TARGET',reason:'A fresh precise target reading is available; a neighbor estimate is not needed.',anchor,anchorAgeMinutes:age};
  if(age>cfg.maxAnchorMinutes)return {ok:false,status:'STALE_ANCHOR',reason:`Precise target anchor is ${Math.round(age)} minutes old (limit ${cfg.maxAnchorMinutes}); not extrapolating.`,anchor,anchorAgeMinutes:age};
  const deltas={},inputs=[],neighborDiagnostics=[];
  for(const id of spec.neighbors) {
    const rr=good.filter(r=>r.station===id);
    const a=rr.filter(r=>C.ms(r.t)<=C.ms(anchor.t)&&C.ms(anchor.t)-C.ms(r.t)<=15*60000).at(-1);
    const b=rr.filter(r=>C.ms(r.t)<=now&&now-C.ms(r.t)<=cfg.maxNeighborAgeMinutes*60000).at(-1);
    const latest=rr.at(-1);
    const diagnostic={station:id,anchorAt:a?.t||null,latestAt:latest?.t||null,latestAgeMinutes:latest?(now-C.ms(latest.t))/60000:null};
    if(!rr.length){neighborDiagnostics.push({...diagnostic,status:'NO_USABLE_NEIGHBOR_REPORT'});continue;}
    if(!a){neighborDiagnostics.push({...diagnostic,status:'MISSING_ANCHOR_PAIR'});continue;}
    if(!b){neighborDiagnostics.push({...diagnostic,status:'NEIGHBOR_TOO_OLD'});continue;}
    if(C.ms(b.t)<=C.ms(a.t)){neighborDiagnostics.push({...diagnostic,status:'NO_NEWER_NEIGHBOR_REPORT'});continue;}
    const d=b.f-a.f;
    if(Math.abs(d)>12){neighborDiagnostics.push({...diagnostic,status:'CHANGE_TOO_LARGE'});continue;} // Abstain on extreme/local discontinuities rather than extrapolating.
    neighborDiagnostics.push({...diagnostic,status:'PAIRED'});
    deltas[id]=d;inputs.push({station:id,deltaF:d,anchorAt:a.t,latestAt:b.t,
      latestAgeMinutes:(now-C.ms(b.t))/60000,precisionC:b.precisionC,structured:!!b.structured,source:b.source});
  }
  if(inputs.length<2)return {ok:false,status:'INSUFFICIENT_NEIGHBORS',reason:`${inputs.length} of ${spec.neighbors.length} neighbors have fresh paired changes; at least 2 are required. See each neighbor below.`,anchor,anchorAgeMinutes:age,inputs,neighborDiagnostics};
  return {ok:true,station,at:C.iso(now),date:C.date(now,spec.offset),anchorAt:anchor.t,anchorId:anchor.id,
    anchorF:anchor.f,anchorAgeMinutes:age,horizon:bucket(age),regime:regime(anchor,spec.tz),deltas,inputs,
    equalDelta:mean(Object.values(deltas)),neighborDiagnostics};
}
function fit(rows,ids) {
  const out={};
  for(const id of ids) {
    const a=rows.filter(r=>Number.isFinite(r.deltas[id]));
    if(a.length<10)continue;
    const xx=a.reduce((s,r)=>s+r.deltas[id]**2,0),xy=a.reduce((s,r)=>s+r.deltas[id]*r.changeF,0);
    const slope=clip(xy/(xx+10),0,1.5);
    const mse=mean(a.map(r=>(r.changeF-slope*r.deltas[id])**2));
    out[id]={slope,n:a.length,mse,weight:1/(mse+0.25)};
  }
  const n=Object.keys(out).length,sw=Object.values(out).reduce((s,x)=>s+x.weight,0);
  for(const x of Object.values(out))x.weight=0.5/n+0.5*x.weight/sw;
  return out;
}
function predict(model,deltas) {
  const a=Object.entries(model).filter(([s])=>Number.isFinite(deltas[s]));
  if(a.length<2)return null;
  return a.reduce((s,[id,m])=>s+m.weight*m.slope*deltas[id],0)/a.reduce((s,[,m])=>s+m.weight,0);
}
function train(training,station,horizon,currentDate,reg,cfg) {
  const spec=cfg.targets[station];
  const base=training.filter(r=>r.station===station&&r.horizon===horizon&&r.date<currentDate&&!r.revised);
  const specific=base.filter(r=>r.regime===reg);
  const distinct=a=>[...new Set(a.map(r=>r.date))].sort();
  const minDays=cfg.minTrainingDays+cfg.minValidationDays;
  const useRegime=specific.length>=cfg.minTrainingSamples+cfg.minValidationSamples&&distinct(specific).length>=minDays;
  const rows=(useRegime?specific:base).sort((a,b)=>a.at.localeCompare(b.at));
  const days=distinct(rows);
  const empty={mode:'COLLECTING_VALIDATION',reason:'Collecting prospective pairs; weights are not yet validated',weights:{},
    scope:useRegime?'matching weather regime':'pooled weather regimes',samples:rows.length,days:days.length,
    trainDays:0,validationDays:0,validationSamples:0};
  if(days.length<minDays)return empty;
  const split=Math.max(cfg.minTrainingDays,Math.min(days.length-cfg.minValidationDays,Math.floor(days.length*.7)));
  const testDay=days[split],tr=rows.filter(r=>r.date<testDay),va=rows.filter(r=>r.date>=testDay);
  if(tr.length<cfg.minTrainingSamples||va.length<cfg.minValidationSamples)return empty;
  const weights=fit(tr,spec.neighbors);
  const scored=va.map(r=>({r,delta:predict(weights,r.deltas)})).filter(x=>x.delta!=null);
  if(scored.length<cfg.minValidationSamples||new Set(scored.map(x=>x.r.date)).size<cfg.minValidationDays)return empty;
  const errors=scored.map(({r,delta})=>Math.abs(r.changeF-delta));
  const mae=mean(errors),persistenceMAE=mean(scored.map(({r})=>Math.abs(r.changeF))),
    equalChangeMAE=mean(scored.map(({r})=>Math.abs(r.changeF-r.equalDelta)));
  const validated=mae<(1-cfg.improvementRequired)*persistenceMAE&&mae<(1-cfg.improvementRequired)*equalChangeMAE;
  return {...empty,mode:validated?'VALIDATED_ADVISORY':'BASELINE_BETTER',
    reason:validated?'Beat persistence and equal-change baselines on later, held-out days':'Did not beat both baselines; persistence remains preferred',
    weights,trainDays:split,trainSamples:tr.length,validationDays:days.length-split,validationSamples:scored.length,
    validationStart:testDay,validationEnd:days.at(-1),mae,persistenceMAE,equalChangeMAE,
    empiricalAbsErrorP90F:q(errors,.9),modelId:C.hash([weights,days.at(-1),horizon,reg]).slice(0,16)};
}
function nowcast(rows,station,now,state,cfg) {
  const f=features(rows,station,now,cfg);const limits={minPairs:2,maxNeighborAgeMinutes:cfg.maxNeighborAgeMinutes,maxAnchorMinutes:cfg.maxAnchorMinutes};
  if(!f.ok)return {station,ok:false,limits,status:f.status||'ABSTAIN',reason:f.reason,anchorAt:f.anchor?.t||null,
    anchorAgeMinutes:f.anchorAgeMinutes??null,inputs:f.inputs||[],neighborDiagnostics:f.neighborDiagnostics||[],eligibleForLocks:false,
    candidateF:null,preferredF:f.status==='FRESH_TARGET'?f.anchor?.f:null,
    validationRequirements:{trainingDays:cfg.minTrainingDays,trainingSamples:cfg.minTrainingSamples,validationDays:cfg.minValidationDays,validationSamples:cfg.minValidationSamples}};
  const model=train(state.training||[],station,f.horizon,f.date,f.regime,cfg);
  const learned=predict(model.weights,f.deltas),delta=learned==null?f.equalDelta:learned;
  const validated=model.mode==='VALIDATED_ADVISORY';
  return {...f,limits,status:model.mode,model,candidateF:f.anchorF+delta,preferredF:validated?f.anchorF+delta:f.anchorF,
    baselineF:f.anchorF,eligibleForLocks:false,validationRequirements:{trainingDays:cfg.minTrainingDays,trainingSamples:cfg.minTrainingSamples,validationDays:cfg.minValidationDays,validationSamples:cfg.minValidationSamples},
    caveat:'Estimate of current temperature, not a measured peak or CLI probability. No effect on official floors or trade eligibility.'};
}
/** Grade only an estimate issued before the exact target observation time (<=2 min).
 * Later precise reports supply labels, never features. One score per target timestamp. */
function gradeArrivals(state,rows,cfg,now,log=()=>{}) {
  state.training ||= [];state.pending ||= {};state.labels ||= {};
  for(const r of C.selectRows(rows,now).filter(r=>r.conflict&&cfg.targets[r.station])) {
    const key=r.station+'|'+r.t;
    if(state.training.some(x=>x.truthKey===key)){state.training=state.training.filter(x=>x.truthKey!==key);state.labels[key]={c:null,revised:true};log('LABEL_CONFLICT',{key});}
  }
  for(const truth of C.selectRows(rows,now).filter(r=>cfg.targets[r.station]&&r.precise&&!r.conflict&&r.f!=null)) {
    const key=truth.station+'|'+truth.t;
    const prev=state.labels[key];
    if(prev) {
      if(prev.c!==truth.c){state.training=state.training.filter(r=>r.truthKey!==key);state.labels[key]={c:truth.c,revised:true};log('LABEL_CORRECTION',{key});}
      continue;
    }
    const candidates=(state.pending[truth.station]||[]).filter(p=>C.ms(p.at)<=C.ms(truth.t)&&C.ms(truth.t)-C.ms(p.at)<=120000&&C.ms(p.anchorAt)<C.ms(truth.t)&&C.ms(p.at)<C.ms(truth.firstReceivedAt));
    const p=candidates.at(-1);if(!p)continue;
    state.labels[key]={c:truth.c};
    const row={station:p.station,date:C.date(truth.t,cfg.targets[p.station].offset),at:p.at,horizon:p.horizon,regime:p.regime,
      deltas:p.deltas,equalDelta:p.equalDelta,changeF:truth.f-p.anchorF,truthKey:key,truthId:truth.id,
      labelReceivedAt:truth.firstReceivedAt,candidateErrorF:p.candidateF-truth.f,preferredErrorF:p.preferredF-truth.f,
      modelId:p.modelId||null};
    state.training.push(row);log('NEIGHBOR_SCORE',row);
  }
  const oldest=C.iso(now-cfg.trainingDays*86400000).slice(0,10);
  state.training=state.training.filter(r=>r.date>=oldest);
  for(const k of Object.keys(state.labels))if(k.slice(5,15)<oldest)delete state.labels[k];
  for(const s of Object.keys(state.pending))state.pending[s]=state.pending[s].filter(p=>now-C.ms(p.at)<3*3600000);
}
function rememberPrediction(state,p,log=()=>{}) {
  if(!p.ok)return;
  state.pending ||= {};const rows=state.pending[p.station] ||= [];
  if(rows.some(r=>r.at===p.at))return;
  const row={station:p.station,at:p.at,date:p.date,anchorAt:p.anchorAt,anchorF:p.anchorF,horizon:p.horizon,
    regime:p.regime,deltas:p.deltas,equalDelta:p.equalDelta,candidateF:p.candidateF,preferredF:p.preferredF,
    modelId:p.model?.modelId||null,status:p.status};
  rows.push(row);log('NEIGHBOR_ESTIMATE',row);
}
module.exports={features,fit,predict,train,nowcast,gradeArrivals,rememberPrediction,bucket};
