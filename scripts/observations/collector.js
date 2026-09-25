'use strict';
const fs=require('node:fs'),path=require('node:path'),zlib=require('node:zlib');
const C=require('./core'),W=require('./weights'),H=require('./http');
const Shadow=require('../shadow/core.js');
const atomic=(p,d)=>{fs.mkdirSync(path.dirname(p),{recursive:true});const t=p+'.tmp';fs.writeFileSync(t,JSON.stringify(d)+'\n');fs.renameSync(t,p);};
function readFile(p,fallback){try{return JSON.parse(fs.readFileSync(p,'utf8'));}catch(e){if(e.code==='ENOENT')return fallback;throw Error('Refusing to reset unreadable observation state: '+e.message);}}
async function mapLimit(items,n,fn){let i=0;await Promise.all(Array.from({length:Math.min(n,items.length)},async()=>{while(i<items.length){const j=i++;await fn(items[j],j);}}));}
class ObservationCollector{
 constructor(root,cfg,{read,clock=Date.now}={}){
  this.root=root;this.cfg=C.validate(cfg);this.clock=clock;this.read=read;this.ids=C.allStations(cfg);
  this.out=path.join(root,'docs/data/observations');
  this.state=readFile(path.join(this.out,'state.json'),{schemaVersion:1,variants:{},products:{},dsm:{},checks:{},training:[],pending:{},labels:{},sampling:{cycles:0,maxGapSeconds:0}});
  if(this.state.schemaVersion!==1)throw Error('Unknown observations schema; refusing reset');
  this.read ||= H.client(cfg,global.fetch,clock,this.state.providerCooldowns ||= {});
  this.logs=[];this.due={};this.attempt=0;this.history=[];
 }
 log(kind,data){this.logs.push({at:C.iso(this.clock()),kind,...data});}
 add(r){if(!r)return;const old=this.state.variants[r.id];
  if(!old){this.state.variants[r.id]={...r,seenBy:{[r.source]:r.receivedAt}};this.log('OBSERVATION_FIRST_SEEN',r);}
  else{old.seenBy ||= {};if(!old.seenBy[r.source]){old.seenBy[r.source]=r.receivedAt;this.log('SOURCE_ARRIVAL',{id:r.id,source:r.source,receivedAt:r.receivedAt});}}
 }
 async task(key,fn){const began=this.clock();try{const result=await fn();this.state.checks[key]={...result,ok:true,checkedAt:C.iso(this.clock()),durationMs:this.clock()-began};}
  catch(e){this.state.checks[key]={...this.state.checks[key],ok:false,attemptedAt:C.iso(this.clock()),error:e.message};this.log('SOURCE_ERROR',{source:key,error:e.message});}
  // Each source publishes without waiting for the other providers or market books.
  this.publishShared();
 }
 async aviation(){const chunks=[];for(let i=0;i<this.ids.length;i+=5)chunks.push(this.ids.slice(i,i+5));
  await mapLimit(chunks,4,ids=>this.task('AWC:'+ids.join(','),async()=>{
   const r=await this.read('https://aviationweather.gov/api/data/metar?ids='+ids.join(',')+'&format=json&hours=3');
   if(!Array.isArray(r.data))throw Error('Unexpected AWC schema');
   let n=0;const recordIds=[];for(const row of r.data){const o=C.parseMetar(row,'AWC',C.ms(r.receivedAt),r.url,ids);if(o){this.add(o);recordIds.push(o.id);n++;}}
   if(r.data.length>=400)throw Error('AWC result cap reached; coverage incomplete');
   return {stations:ids,records:n,supplied:r.data.length,rejected:r.data.length-n,rejectionReasons:r.data.length>n?{INVALID_RAW_REPORT:r.data.length-n}:{},recordIds,receivedAt:r.receivedAt,url:r.url,httpDate:r.httpDate,httpAge:r.httpAge};
  }));
 }
 async nws(){await mapLimit(this.ids,4,id=>this.task('NWS:'+id,async()=>{
  const r=await this.read(`https://api.weather.gov/stations/${id}/observations?limit=36`);
  if(!Array.isArray(r.data?.features))throw Error('Unexpected NWS observation schema');
  let n=0,rawRecords=0,structuredRecords=0,monitorOnlyRecords=0;const rejectionReasons={};
  for(const f of r.data.features){const v=C.inspectNWS(f.properties,id,C.ms(r.receivedAt),r.url,this.ids),o=v.row;
   if(o){this.add(o);n++;if(o.structured){structuredRecords++;if(!o.trendEligible)monitorOnlyRecords++;}else rawRecords++;}
   else rejectionReasons[v.reason]=(rejectionReasons[v.reason]||0)+1;
  }
  return {stations:[id],records:n,supplied:r.data.features.length,rejected:r.data.features.length-n,rawRecords,structuredRecords,monitorOnlyRecords,rejectionReasons,receivedAt:r.receivedAt,url:r.url,httpDate:r.httpDate,httpAge:r.httpAge};
 }));}
 async raw(){await mapLimit(Object.keys(this.cfg.targets),3,id=>this.task('RAW:'+id,async()=>{
  const r=await this.read(`https://tgftp.nws.noaa.gov/data/observations/metar/stations/${id}.TXT`,'text');
  const text=String(r.data).split(/\n/).map(s=>s.trim());const raw=text.find(s=>new RegExp('^(?:(?:METAR|SPECI) )?'+id+' ').test(s));
  const o=C.parseMetar({rawOb:raw},'NOAA_RAW',C.ms(r.receivedAt),r.url,[id]);if(!o)throw Error('No valid matching raw station report');this.add(o);
  return {stations:[id],records:1,receivedAt:r.receivedAt,url:r.url};
 }));}
 async cli(){await mapLimit(Object.entries(this.cfg.targets),3,([id,s])=>this.task('CLI:'+id,async()=>{
  const r=await this.read(`https://api.weather.gov/products/types/CLI/locations/${s.cli}`);
  const g=r.data?.['@graph'];if(!Array.isArray(g))throw Error('Unexpected CLI list schema');
  let n=0,productIds=[];
  const entries=g.filter(p=>/^[A-Za-z0-9-]+$/.test(p.id)&&C.ms(p.issuanceTime)<=this.clock()).sort((a,b)=>C.ms(b.issuanceTime)-C.ms(a.issuanceTime)).slice(0,4);
  await mapLimit(entries,2,async p=>{
   let item=this.state.products[p.id];
   if(!item){const q=await this.read(`https://api.weather.gov/products/${p.id}`);const product={...q.data,id:p.id,issuanceTime:q.data.issuanceTime||p.issuanceTime};
    const evidence=Shadow.parseCLI(product,id,C.ms(q.receivedAt));if(!evidence)return;
    item={product,evidence,firstReceivedAt:q.receivedAt};this.state.products[p.id]=item;this.log('CLI_FIRST_SEEN',{station:id,...item});}
   if(item.evidence.station===id){n++;productIds.push(p.id);}
  });
  if(!n)throw Error('No valid station CLI');return {stations:[id],records:n,productIds,receivedAt:r.receivedAt,url:r.url};
 }));}
 async dsm(){await mapLimit(Object.entries(this.cfg.targets),2,([id,s])=>this.task('DSM:'+id,async()=>{
  const wfo={KNYC:'OKX',KMIA:'MFL',KMDW:'LOT',KLAX:'LOX',KSFO:'MTR'};
  const url=s.dsmUrl||`https://forecast.weather.gov/product.php?site=${wfo[id]}&issuedby=${s.cli}&product=DSM&format=txt&version=1&glossary=0`;
  const r=await this.read(url,'text');let text=String(r.data);const pre=text.match(/<pre[^>]*>([\s\S]*?)<\/pre>/i);if(pre)text=pre[1];
  text=text.replace(/<[^>]*>/g,' ').replace(/&gt;/g,'>').replace(/&lt;/g,'<').replace(/&amp;/g,'&');
  const d=C.parseDSM(text,id,C.ms(r.receivedAt),url);if(!d)throw Error('DSM missing, stale, or unsupported; research-only source skipped');
  const key=id+'|'+d.date;const old=this.state.dsm[key];if(old?.id!==d.id){this.state.dsm[key]=d;this.log('DSM_RESEARCH',d);}
  return {stations:[id],records:1,receivedAt:r.receivedAt,url,advisoryOnly:true};
 }));}
 prune(){const cutoff=this.clock()-this.cfg.keepHours*3600000;
  for(const [k,r]of Object.entries(this.state.variants))if(C.ms(r.t)<cutoff)delete this.state.variants[k];
  for(const [k,r]of Object.entries(this.state.products))if(C.ms(r.evidence.issuedAt)<this.clock()-9*86400000)delete this.state.products[k];
  for(const [k,r]of Object.entries(this.state.dsm))if(C.ms(r.receivedAt)<this.clock()-9*86400000)delete this.state.dsm[k];
 }
 publishShared(){const now=this.clock();const selected=C.selectRows(Object.values(this.state.variants),now);
  atomic(path.join(this.out,'shared.json'),{schemaVersion:1,version:'1.0.1',generatedAt:C.iso(now),rows:selected,
   products:Object.values(this.state.products),checks:this.state.checks,conflicts:selected.filter(r=>r.conflict).map(r=>({station:r.station,t:r.t,variants:r.variants})),
   note:'Structured NWS rows are observation-only, never extrema. DSM/nearby estimates excluded. Timestamp/quality validation required by each consumer.'});
 }
 publishDashboard(){const now=this.clock(),rows=Object.values(this.state.variants);W.gradeArrivals(this.state,rows,this.cfg,now,(k,d)=>this.log(k,d));
  const selected=C.selectRows(rows,now);
  const stations=Object.entries(this.cfg.targets).map(([id,s])=>{
   const own=selected.filter(r=>r.station===id&&!r.conflict&&r.f!=null),last=own.at(-1);const cadence=C.cadenceInfo(own,now);
   const nc=W.nowcast(rows,id,now,this.state,this.cfg);W.rememberPrediction(this.state,nc,(k,d)=>this.log(k,d));
   const curDate=C.date(now,s.offset),evidence={};
   for(const r of selected.filter(x=>x.station===id&&!x.conflict&&!x.advisoryOnly&&!x.structured))for(const e of Shadow.parseMetar({icaoId:r.station,obsTime:C.ms(r.t)/1000,rawOb:r.raw},C.ms(r.firstReceivedAt)))evidence[e.key]={...e,sourceUrl:r.sourceUrl,receivedAt:r.firstReceivedAt,firstSeenAt:r.firstReceivedAt};
   for(const p of Object.values(this.state.products)){const e=p.evidence;if(e.station===id)evidence[e.id]=e;}
   const official=Shadow.chooseEvidence(evidence,id,curDate,now);
   const arrivals=own.filter(r=>C.ms(r.firstReceivedAt)>=now-24*3600000).map(r=>(C.ms(r.firstReceivedAt)-C.ms(r.t))/1000).sort((a,b)=>a-b);
   const checks=Object.entries(this.state.checks).filter(([k,c])=>c.stations?.includes(id)&&!k.startsWith('DSM')).map(([k,c])=>({source:k,...c}));
   return {station:id,name:s.name,date:curDate,observed:last?{f:last.f,precisionC:last.precisionC,at:last.t,receivedAt:last.firstReceivedAt,source:last.source,sourceUrl:last.sourceUrl,
    structured:!!last.structured,temperatureQC:last.temperatureQC||null,trendEligible:last.trendEligible!==false,precisionNote:last.precisionNote||null,
    ageSeconds:(now-C.ms(last.t))/1000,firstSeenDelaySeconds:(C.ms(last.firstReceivedAt)-C.ms(last.t))/1000}:null,
    latency:{records:arrivals.length,firstSeenP50Seconds:arrivals[Math.floor(arrivals.length*.5)]??null,firstSeenP90Seconds:arrivals[Math.floor(arrivals.length*.9)]??null,
     note:'Observation-to-first-receipt includes station cadence, source delay and our schedule; not a pure network benchmark.'},
    evidence:official,neighbor:nc,cadence,checks,dsm:this.state.dsm[id+'|'+curDate]||null,
    trainingPairs:this.state.training.filter(r=>r.station===id).length,
    conflicts:selected.filter(r=>r.station===id&&r.conflict).length};
  });
  const fresh=Object.entries(this.state.checks).filter(([k,c])=>!k.startsWith('DSM:')&&c.ok&&c.records>0&&now-C.ms(c.checkedAt)<360000);
  const snap={schemaVersion:1,version:'1.0.1',generatedAt:C.iso(now),paperOnly:true,stations,sampling:this.state.sampling,
   health:{ok:fresh.length>0,checks:this.state.checks},notes:['Publication to GitHub happens at session end, not every sampling minute.','Neighbor nowcasts and DSM research never authorize locks or paper trades.']};
  atomic(path.join(this.out,'latest.json'),snap);return snap;
 }
 flush(){this.prune();this.publishShared();atomic(path.join(this.out,'state.json'),this.state);
  if(this.logs.length){const byDay={};for(const r of this.logs)(byDay[r.at.slice(0,10)] ||= []).push(r);
   fs.mkdirSync(path.join(this.out,'history'),{recursive:true});for(const [d,rr]of Object.entries(byDay))fs.appendFileSync(path.join(this.out,'history',d+'.jsonl.gz'),zlib.gzipSync(rr.map(r=>JSON.stringify(r)).join('\n')+'\n'));
   this.logs=[];}
 }
 async cycle(){const start=this.clock(),sample=this.state.sampling;const gap=sample.lastCycleAt?(start-C.ms(sample.lastCycleAt))/1000:null;
  sample.cycles++;sample.lastCycleAt=C.iso(start);sample.lastGapSeconds=gap;sample.maxGapSeconds=Math.max(sample.maxGapSeconds||0,gap||0);
  const jobs=[this.aviation()];
  for(const [key,seconds]of [['nws',this.cfg.nwsSeconds],['cli',this.cfg.cliSeconds],['raw',this.cfg.rawSeconds],['dsm',this.cfg.dsmSeconds]])
    if(!this.due[key]||start>=this.due[key]){this.due[key]=start+seconds*1000;jobs.push(this[key]());}
  await Promise.allSettled(jobs);const snap=this.publishDashboard();this.log('OBS_CYCLE',{durationMs:this.clock()-start,gapSeconds:gap,rows:Object.keys(this.state.variants).length});this.flush();return snap;
 }
}
module.exports={ObservationCollector,atomic,readFile,mapLimit};
