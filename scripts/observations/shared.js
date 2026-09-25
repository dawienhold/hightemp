'use strict';
const fs=require('node:fs'),path=require('node:path');
function load(root,now=Date.now()){
 try{const p=path.join(root,'docs/data/observations/shared.json'),d=JSON.parse(fs.readFileSync(p,'utf8'));
  if(d.schemaVersion!==1||!Array.isArray(d.rows)||!Number.isFinite(Date.parse(d.generatedAt))||Date.parse(d.generatedAt)>now)return null;
  return d;
 }catch{return null;}
}
function rowsFor(d,station,since,now=Date.now()){
 if(!d)return [];
 return d.rows.filter(r=>r.station===station&&!r.conflict&&!r.omo&&!r.inferred&&!r.advisoryOnly&&['AWC','NWS','NOAA_RAW'].includes(r.source)
  &&Date.parse(r.t)>=since&&Date.parse(r.t)<=now&&Date.parse(r.firstReceivedAt)<=now&&typeof r.raw==='string')
  .map(r=>({...r,t:new Date(r.t)}));
}
function ingestShadow(collector){
 const now=collector.clock(),d=load(collector.root,now),status={aviation:false,cli:new Set()};
 if(!d||now-Date.parse(d.generatedAt)>180000)return status;
 const C=require('../shadow/core');const targets=collector.cfg.stations;
 collector.sharedConflicts=(d.conflicts||[]).filter(r=>targets.includes(r.station));
 for(const r of collector.sharedConflicts){delete collector.state.evidence[r.station+'|'+r.t+'|SIX'];delete collector.state.evidence[r.station+'|'+r.t+'|T'];}
 const checks=Object.entries(d.checks||{}).filter(([k,v])=>k.startsWith('AWC:')&&v.ok&&now-Date.parse(v.checkedAt)<=collector.cfg.maxWeatherCheckAgeSeconds*1000);
 const covered=new Set(checks.flatMap(([,v])=>v.stations||[]));
 const recheckedIds=new Set(checks.flatMap(([,v])=>v.recordIds||[]));
 const evIds=[];
 for(const r of d.rows){if(!targets.includes(r.station)||r.conflict||r.omo||r.advisoryOnly||r.inferred)continue;
  for(const e of C.parseMetar({icaoId:r.station,obsTime:Date.parse(r.t)/1000,rawOb:r.raw},Date.parse(r.firstReceivedAt))){
   const actual={...e,sourceUrl:r.sourceUrl,receivedAt:r.firstReceivedAt};collector.remember(actual);if(recheckedIds.has(r.id))evIds.push(actual.id);}
 }
 if(targets.every(s=>covered.has(s))&&evIds.length){
  status.aviation=true;collector.state.sourceChecks.aviation={ok:true,checkedAt:new Date(Math.min(...checks.map(([,v])=>Date.parse(v.checkedAt)))).toISOString(),evidenceIds:evIds,records:evIds.length,via:'shared observation collector'};
 }
 for(const station of targets){const check=d.checks?.['CLI:'+station];if(!check?.ok||now-Date.parse(check.checkedAt)>collector.cfg.maxWeatherCheckAgeSeconds*1000)continue;
  const ids=[];for(const p of d.products||[]){if(!check.productIds?.includes(p.product?.id))continue;
   const e=C.parseCLI(p.product,station,Date.parse(p.firstReceivedAt));if(e){collector.remember(e);ids.push(e.id);}}
  if(ids.length){status.cli.add(station);collector.state.sourceChecks['cli:'+station]={ok:true,checkedAt:check.checkedAt,evidenceIds:ids,records:ids.length,via:'shared observation collector'};}
 }
 return status;
}
module.exports={load,rowsFor,ingestShadow};
