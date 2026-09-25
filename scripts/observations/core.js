'use strict';
const crypto = require('node:crypto');
const hash = s => crypto.createHash('sha256').update(typeof s === 'string' ? s : JSON.stringify(s)).digest('hex');
const ms = x => x instanceof Date ? x.getTime() : typeof x === 'number' ? x : Date.parse(x);
const iso = x => new Date(x).toISOString();
const number = x => typeof x === 'number' && Number.isFinite(x) ? x : null;
const cToF = c => c * 1.8 + 32;
const date = (t, offset) => iso(ms(t) + offset * 3600000).slice(0, 10);
const allStations = cfg => [...new Set(Object.entries(cfg.targets).flatMap(([s,t]) => [s,...t.neighbors]))];
function validate(cfg) {
  if(typeof cfg.enabled !== 'boolean') throw Error('enabled must be boolean');
  if(cfg.pollSeconds < 60 || cfg.pollSeconds > 600 || cfg.sessionSeconds < 0 || cfg.sessionSeconds > 240) throw Error('Invalid observation schedule');
  if(cfg.requestTimeoutMs < 1000 || cfg.requestTimeoutMs > 15000) throw Error('Invalid request budget');
  if(cfg.keepHours < 30 || cfg.keepHours > 72 || cfg.trainingDays < 10 || cfg.trainingDays > 365) throw Error('Invalid retention window');
  for(const k of ['nwsSeconds','cliSeconds','rawSeconds','dsmSeconds']) if(!(cfg[k]>=60))throw Error('Invalid cadence: '+k);
  for(const k of ['minTrainingDays','minTrainingSamples','minValidationDays','minValidationSamples'])if(!(cfg[k]>=1))throw Error('Invalid training setting: '+k);
  if(!(cfg.improvementRequired>=0.02&&cfg.improvementRequired<0.5))throw Error('Invalid improvement threshold');
  if(!cfg.targets || Object.keys(cfg.targets).some(s=>!['KNYC','KMIA','KMDW','KLAX','KSFO'].includes(s)))throw Error('Unsupported target station');
  if(allStations(cfg).length>30 || allStations(cfg).some(s=>!/^K[A-Z0-9]{3}$/.test(s)))throw Error('Unsupported station set');
  return cfg;
}
function resolveDay(ddhhmm, reference) {
  const r = new Date(ms(reference));
  const dd=+ddhhmm.slice(0,2), hh=+ddhhmm.slice(2,4), mm=+ddhhmm.slice(4,6);
  if(dd<1||dd>31||hh>23||mm>59)return null;
  const a=[-1,0,1].map(k=>Date.UTC(r.getUTCFullYear(),r.getUTCMonth()+k,dd,hh,mm)).filter(t=>new Date(t).getUTCDate()===dd);
  return a.sort((x,y)=>Math.abs(x-+r)-Math.abs(y-+r))[0]??null;
}
/** Strip only known transport wrappers; never scan arbitrary prose for a report. */
function normalizeMetar(text) {
  if(typeof text!=='string'||text.length>65536)return '';
  let lines=text.replace(/[\x01\x03]/g,'').replace(/\r/g,'').trim().split('\n').map(s=>s.trim()).filter(Boolean);
  for(let k=0;k<3&&lines.length>1;k++) {
    if(/^\d{3}$/.test(lines[0])||/^\d{4}\/\d{2}\/\d{2}\s+\d{2}:\d{2}$/.test(lines[0])||
       /^[A-Z]{4}\d{2}\s+K[A-Z0-9]{3}\s+\d{6}(?:\s+[A-Z]{3})?$/.test(lines[0]))lines.shift();
    else break;
  }
  const raw=lines.join(' ').replace(/\s+/g,' ').trim().replace(/=$/,'').trim();
  const heads=raw.match(/(?:^|\s)(?:METAR\s+|SPECI\s+)?K[A-Z0-9]{3}\s+\d{6}Z\b/g)||[];
  return heads.length===1?raw:'';
}
/** Strict raw temperature/extrema parser; decimal tails in JSON never imply precision. */
function parseMetar(o, source, received, url, allowed) {
  const raw=normalizeMetar(o.rawOb||o.rawMessage||'');
  const head=raw.match(/^(?:(?:METAR|SPECI)\s+)?(K[A-Z0-9]{3})\s+(\d{6})Z\b/);
  if(!head||!allowed.includes(head[1]))return null;
  const station=head[1];if(o.icaoId&&o.icaoId!==station)return null;
  const t=number(o.obsTime)!=null?o.obsTime*1000:o.timestamp?Date.parse(o.timestamp):resolveDay(head[2],received);
  if(!Number.isFinite(t)||!Number.isFinite(received)||t>received||received-t>72*3600000)return null;
  const dt=new Date(t),h=head[2];
  if(dt.getUTCDate()!==+h.slice(0,2)||dt.getUTCHours()!==+h.slice(2,4)||dt.getUTCMinutes()!==+h.slice(4,6))return null;
  const rmk=raw.split(/\bRMK\b/)[1]||'';
  const tg=rmk.match(/(?:^|\s)T([01])(\d{3})[01]\d{3}(?:\s|$)/);
  const whole=raw.split(/\bRMK\b/)[0].match(/(?:^|\s)(M?\d{2})\/(M?\d{2}|\/)(?:\s|$)/);
  const c=tg?(tg[1]==='1'?-1:1)*+tg[2]/10:whole?(whole[1][0]==='M'?-1:1)*+whole[1].replace('M',''):null;
  const sx=rmk.match(/(?:^|\s)1([01])(\d{3})(?:\s|$)/);
  const sixMaxC=sx?(sx[1]==='1'?-1:1)*+sx[2]/10:null;
  if((c==null&&sixMaxC==null)||(c!=null&&(c < -80||c > 65))||(sixMaxC!=null&&(sixMaxC < -80||sixMaxC > 65)))return null;
  const wind=raw.match(/\b(\d{3}|VRB)(\d{2,3})(?:G(\d{2,3}))?KT\b/);
  return {id:hash([station,iso(t),raw]),station,t:iso(t),c,f:c==null?null:cToF(c),precise:!!tg,
    sixMaxC,raw,source,sourceUrl:url,receivedAt:iso(received),firstReceivedAt:iso(received),
    corrected:/\bCOR\b/.test(raw),windDir:wind&&wind[1]!=='VRB'?+wind[1]:null,
    windKt:wind?+wind[2]:null,wet:/\b[-+]?(?:TS|SH)?(?:RA|DZ|SN)\b/.test(raw),
    precisionC:tg?0.1:1,advisoryOnly:false,structured:false,trendEligible:true};
}
const GOOD_QC=new Set(['C','S','V','G','T']);
const BAD_QC=new Set(['X','Q','B','I','W']);
const stationFrom=x=>typeof x==='string'?(x.match(/(?:^|\/)(K[A-Z0-9]{3})\/?$/)||[])[1]:null;
function temperatureC(q) {
  const v=number(q?.value);if(v==null)return null;
  if(q.unitCode==='wmoUnit:degC')return v;
  if(q.unitCode==='wmoUnit:degF')return (v-32)/1.8;
  if(q.unitCode==='wmoUnit:K')return v-273.15;
  return null;
}
/** Structured NWS readings are observation-only: never extrema, precise anchors or labels. */
function inspectNWS(p,station,received,url,allowed) {
  const reject=reason=>({row:null,reason});
  if(!p||!allowed.includes(station))return reject('UNSUPPORTED_STATION');
  let u;try{u=new URL(url);}catch{return reject('INVALID_NWS_SOURCE');}
  if(u.protocol!=='https:'||u.hostname!=='api.weather.gov'||u.pathname!==`/stations/${station}/observations`)return reject('INVALID_NWS_SOURCE');
  for(const key of ['station','stationId','stationIdentifier'])if(p[key]!=null&&stationFrom(p[key])!==station)return reject('STATION_MISMATCH');
  const t=Date.parse(p.timestamp);
  if(!/(?:Z|[+-]\d{2}:\d{2})$/.test(String(p.timestamp))||!Number.isFinite(t)||t>received||received-t>72*3600000)return reject('INVALID_TIMESTAMP');
  const qc=p.temperature?.qualityControl==null?'':String(p.temperature.qualityControl).trim().toUpperCase();
  if(BAD_QC.has(qc))return reject('TEMPERATURE_QC_'+qc);
  const rawText=typeof p.rawMessage==='string'?p.rawMessage.trim():'';
  if(rawText) {
    const raw=normalizeMetar(rawText);
    const head=raw.match(/^(?:(?:METAR|SPECI)\s+)?(K[A-Z0-9]{3})\s+(\d{6})Z\b/);
    if(!head)return reject('UNSUPPORTED_RAW_FORMAT');
    if(head[1]!==station)return reject('RAW_STATION_MISMATCH');
    if(resolveDay(head[2],t)!==Math.floor(t/60000)*60000)return reject('RAW_TIMESTAMP_MISMATCH');
    const parsed=parseMetar({rawOb:raw,timestamp:p.timestamp,icaoId:station},'NWS',received,url,allowed);
    if(parsed){parsed.temperatureQC=qc||null;return {row:parsed,reason:null};}
    // Do not bypass a malformed or implausible present raw temperature.
    if(/(?:^|\s)T[01]\d{3}|(?:^|\s)M?\d{2}\//.test(raw))return reject('INVALID_RAW_TEMPERATURE');
  }
  const c=temperatureC(p.temperature);
  if(c==null)return reject('MISSING_TEMPERATURE_OR_UNITS');
  if(c < -80||c > 65)return reject('TEMPERATURE_OUT_OF_RANGE');
  const qualityPassed=GOOD_QC.has(qc);
  const nws={station:`https://api.weather.gov/stations/${station}`,timestamp:p.timestamp,
    rawMessage:rawText||null,temperature:{value:p.temperature.value,unitCode:p.temperature.unitCode,qualityControl:qc||null}};
  return {row:{id:hash(['NWS_STRUCTURED',station,iso(t),c,qc]),station,t:iso(t),c,f:cToF(c),
    raw:'',originalRaw:rawText||null,source:'NWS_STRUCTURED',sourceUrl:url,
    receivedAt:iso(received),firstReceivedAt:iso(received),precise:false,precisionC:null,
    sixMaxC:null,structured:true,advisoryOnly:true,eligibleForLocks:false,trendEligible:qualityPassed,
    temperatureQC:qc||null,qualityPassed,precisionNote:'Source precision is not established by a raw METAR; decimal digits do not imply accuracy.',
    corrected:false,windDir:null,windKt:null,wet:null,nws},reason:null};
}
function fromNWS(p,station,received,url,allowed){return inspectNWS(p,station,received,url,allowed).row;}
function isStructured(r){return r?.structured===true&&r.source==='NWS_STRUCTURED'&&r.advisoryOnly===true&&r.precise===false&&r.sixMaxC==null;}
function usableTemperature(r){return !!r&&!r.conflict&&!r.omo&&!r.inferred&&number(r.f)!=null&&(!r.advisoryOnly||(isStructured(r)&&r.trendEligible===true));}
/** Preserve full variants. Strict raw reports outrank observation-only rows at the same time. */
function selectRows(variants, asOf=Date.now()) {
  const groups=new Map();
  for(const r of variants||[]) {
    if(!Number.isFinite(ms(r.t))||!Number.isFinite(ms(r.firstReceivedAt||r.receivedAt))||ms(r.t)>asOf||ms(r.firstReceivedAt||r.receivedAt)>asOf||
       (r.advisoryOnly&&!isStructured(r))||r.omo||r.inferred)continue;
    const k=r.station+'|'+iso(ms(r.t));
    if(!groups.has(k))groups.set(k,[]);groups.get(k).push(r);
  }
  const out=[];
  for(const rs of groups.values()) {
    const rawRows=rs.filter(r=>!isStructured(r));
    let a=rawRows.length?rawRows:rs;
    if(!rawRows.length&&a.some(r=>r.trendEligible))a=a.filter(r=>r.trendEligible);
    const corrected=a.filter(r=>r.corrected);if(corrected.length)a=corrected;
    if(a.some(r=>r.precise))a=a.filter(r=>r.precise);
    const sameTemp=new Set(a.map(r=>r.c)),sx=new Set(a.filter(r=>r.sixMaxC!=null).map(r=>r.sixMaxC));
    if(sameTemp.size>1||sx.size>1){out.push({...a[0],conflict:true,variants:a.map(r=>r.id)});continue;}
    a.sort((x,y)=>ms(x.firstReceivedAt||x.receivedAt)-ms(y.firstReceivedAt||y.receivedAt));
    const best=a.find(r=>r.sixMaxC!=null)||a[0];out.push({...best,conflict:false});
  }
  return out.sort((a,b)=>ms(a.t)-ms(b.t));
}
/** Median spacing in the last six hours; observation age is reported separately. */
function cadenceInfo(rows,now) {
  const a=rows.filter(r=>!r.conflict&&number(r.f)!=null&&ms(r.t)<=now).sort((x,y)=>ms(x.t)-ms(y.t));
  const recent=a.filter(r=>ms(r.t)>=now-6*3600000),gaps=[];
  for(let i=1;i<recent.length;i++){const d=(ms(recent[i].t)-ms(recent[i-1].t))/60000;if(d>0)gaps.push(d);}
  gaps.sort((x,y)=>x-y);const n=gaps.length,m=n?((n%2)?gaps[(n-1)/2]:(gaps[n/2-1]+gaps[n/2])/2):null;
  const last=a.at(-1),precise=a.filter(r=>r.precise&&!r.advisoryOnly).at(-1);
  return {windowHours:6,recentRows:recent.length,recentSpacingMinutes:m==null?null:Math.round(m*10)/10,
    latestAt:last?.t||null,latestAgeMinutes:last?(now-ms(last.t))/60000:null,
    latestPreciseAt:precise?.t||null,latestPreciseAgeMinutes:precise?(now-ms(precise.t))/60000:null};
}
/** Research-only DSM: explicit station/date, valid maximum time. Never settlement evidence. */
function parseDSM(text, station, received, url) {
  const raw=String(text).replace(/\r/g,'');
  const header=raw.match(/\b([A-Z]{4}\d{2})\s+(K[A-Z]{3})\s+(\d{6})(?:\s+[A-Z]{3})?\s+DSM([A-Z0-9]{3})\b/);
  if(!header||header[4]!==station.slice(1))return null;
  const issued=resolveDay(header[3],received);
  if(issued==null||issued>received||received-issued>10*86400000)return null;
  const pat=new RegExp('\\b'+station+'\\s+DS\\s+(?:(\\d{4})\\s+)?(\\d{2})/(\\d{2})\\s+(-?\\d{2,3})(\\d{4})/');
  const m=raw.match(pat); if(!m)return null;
  const hhmm=m[5];if(+hhmm.slice(0,2)>23||+hhmm.slice(2)>59)return null;
  const year=new Date(issued).getUTCFullYear();
  const candidates=[year-1,year,year+1].map(y=>`${y}-${m[3]}-${m[2]}`)
    .filter(d=>Number.isFinite(Date.parse(d))&&iso(Date.parse(d)).slice(0,10)===d);
  candidates.sort((a,b)=>Math.abs(Date.parse(a)-issued)-Math.abs(Date.parse(b)-issued));
  if(!candidates.length||Math.abs(Date.parse(candidates[0])-issued)>8*86400000)return null;
  const maxF=+m[4];if(maxF < -100||maxF>150)return null;
  return {id:hash(raw),station,date:candidates[0],kind:'DSM_RESEARCH_ONLY',maxF,maxTimeStandard:hhmm,
    partialAsOfStandard:m[1]||null,issuedAt:iso(issued),receivedAt:iso(received),sourceUrl:url,raw,
    advisoryOnly:true,eligibleForLocks:false};
}
module.exports={hash,ms,iso,number,cToF,date,allStations,validate,resolveDay,normalizeMetar,parseMetar,inspectNWS,fromNWS,isStructured,usableTemperature,selectRows,cadenceInfo,parseDSM};
