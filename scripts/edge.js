#!/usr/bin/env node
'use strict';
const fs=require('node:fs'),path=require('node:path');
const E=require('./edge/core.js');
const C=require('./consistency/core.js');
const root=path.join(__dirname,'..'),data=path.join(root,'docs','data'),out=path.join(data,'edge');
const read=(p,d)=>{try{return JSON.parse(fs.readFileSync(p,'utf8'));}catch(e){if(e.code==='ENOENT')return d;throw e;}};
const lines=p=>{try{return fs.readFileSync(p,'utf8').split('\n').filter(Boolean).map(x=>JSON.parse(x));}catch(e){if(e.code==='ENOENT')return [];throw e;}};
const atomic=(p,o)=>{fs.mkdirSync(path.dirname(p),{recursive:true});const t=p+'.tmp';fs.writeFileSync(t,JSON.stringify(o,null,2)+'\n');fs.renameSync(t,p);};
const append=(p,o)=>{fs.mkdirSync(path.dirname(p),{recursive:true});fs.appendFileSync(p,JSON.stringify(o)+'\n');};
function pruneState(state,now,cfg){const cutoff=new Date(+now-cfg.historyRetentionDays*86400000).toISOString().slice(0,10);for(const k of Object.keys(state.preCutoff||{}))if(k.split('|')[1]<cutoff)delete state.preCutoff[k];for(const k of Object.keys(state.checkpoints||{}))if(k.split('|')[1]<cutoff)delete state.checkpoints[k];for(const k of Object.keys(state.entries||{})){const e=state.entries[k];if(e.date<cutoff&&e.settled)delete state.entries[k];}}
function main(){
  if(process.argv.slice(2).length)throw new Error('No order, replay, or live-trading arguments supported');
  const cfg=E.validateConfig(read(path.join(__dirname,'edge','config.json'),null)),now=new Date();
  const forecast=read(path.join(data,'latest.json'),null),consistency=read(path.join(data,'consistency','latest.json'),null),
    consistencyStatus=read(path.join(data,'consistency','status.json'),null),cli=read(path.join(data,'cli.json'),{});
  if(!forecast?.ranAt)throw new Error('forecast latest.json missing');if(!consistency?.generatedAt)throw new Error('consistency latest.json missing');
  const cAge=(+now-Date.parse(consistency.generatedAt))/60000,fAge=(+now-Date.parse(forecast.ranAt))/60000;
  const historyFile=path.join(data,'history',forecast.ranAt.slice(0,7)+'.jsonl'),historyRows=lines(historyFile);
  const state=read(path.join(out,'state.json'),{version:cfg.version,preCutoff:{},checkpoints:{},entries:{}});pruneState(state,now,cfg);
  const newerConsistencyFailure=consistencyStatus?.health==='FAILED'&&Number.isFinite(Date.parse(consistencyStatus.generatedAt))&&Date.parse(consistencyStatus.generatedAt)>Date.parse(consistency.generatedAt);
  const comparisons=E.compareMarkets(state,forecast,consistency,historyRows,now,cfg),freshEnough=cAge>=-2&&cAge<=cfg.maxConsistencyAgeMinutes&&fAge>=-2&&fAge<=cfg.maxForecastAgeMinutes&&!newerConsistencyFailure;
  if(!freshEnough)for(const r of comparisons)if(['RESEARCH_LEAD','STRONG_RESEARCH_LEAD'].includes(r.status))r.status='SOURCE_SNAPSHOT_STALE';
  const newEntries=freshEnough?E.updateEntries(state,comparisons,now):[],settledNow=E.settleEntries(state,cli),cal=E.calibration(historyRows,cli,cfg),stats=E.entryStats(state.entries);
  state.version=cfg.version;state.updatedAt=C.iso(now);atomic(path.join(out,'state.json'),state);
  const leads=comparisons.filter(r=>['RESEARCH_LEAD','STRONG_RESEARCH_LEAD'].includes(r.status));
  const snapshot={schemaVersion:1,version:cfg.version,mode:'OBSERVE_ONLY',generatedAt:C.iso(now),forecastAt:forecast.ranAt,consistencyAt:consistency.generatedAt,
    health:freshEnough?'CURRENT_SOURCES':newerConsistencyFailure?'NEWER_CONSISTENCY_RUN_FAILED':'STALE_SOURCE_SNAPSHOT',settings:cfg,
    sourceHealth:{forecastAgeMinutes:+fAge.toFixed(2),consistencyAgeMinutes:+cAge.toFixed(2),newerConsistencyFailure},
    summary:{trackedBands:comparisons.length,researchLeads:leads.length,strongLeads:leads.filter(x=>x.status==='STRONG_RESEARCH_LEAD').length,newEntries:newEntries.length,
      checkpoints:Object.keys(state.checkpoints||{}).length,prospectiveEntries:Object.keys(state.entries||{}).length,...stats},
    calibration:cal,comparisons,leads,entries:Object.values(state.entries||{}).sort((a,b)=>String(b.firstSeenAt).localeCompare(String(a.firstSeenAt))).slice(0,100),newEntries,settledNow,
    caveat:'Research only. The 10 AM cohort is fixed before the cutoff; live flags use current model probability and executable NO depth from the verified Polymarket US book snapshot. No order is submitted.'};
  atomic(path.join(out,'latest.json'),snapshot);atomic(path.join(out,'status.json'),{generatedAt:snapshot.generatedAt,health:snapshot.health,summary:snapshot.summary});
  append(path.join(out,'history',snapshot.generatedAt.slice(0,10)+'.jsonl'),{at:snapshot.generatedAt,forecastAt:snapshot.forecastAt,consistencyAt:snapshot.consistencyAt,
    leads:leads.map(x=>({station:x.station,date:x.date,label:x.label,checkpointP:x.checkpointP,currentP:x.currentP,marketYesEquivalent:x.marketYesEquivalent,edge:x.edge,noAsk:x.noAsk,status:x.status})),newEntries,settledNow});
  console.log(JSON.stringify({health:snapshot.health,summary:snapshot.summary,leads:leads.map(x=>({station:x.station,label:x.label,model:x.currentP,marketYes:x.marketYesEquivalent,edge:x.edge,status:x.status}))}));
}
if(require.main===module){try{main();}catch(e){console.error(e.stack||e);process.exitCode=1;}}
module.exports={main};
