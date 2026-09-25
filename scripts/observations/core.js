'use strict';
const crypto = require('node:crypto');
const hash = s => crypto.createHash('sha256').update(typeof s === 'string' ? s : JSON.stringify(s)).digest('hex');
const ms = x => typeof x === 'number' ? x : Date.parse(x);
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
/** Strict observation parser. Raw tenth-C remarks, not JSON decimal tails, establish precision. */
function parseMetar(o, source, received, url, allowed) {
  const raw = String(o.rawOb || o.rawMessage || '').replace(/\s+/g,' ').trim();
  const head=raw.match(/^(?:(?:METAR|SPECI)\s+)?(K[A-Z0-9]{3})\s+(\d{6})Z\b/);
  if(!head || !allowed.includes(head[1]))return null;
  const station=head[1];
  if(o.icaoId && o.icaoId!==station)return null;
  const t=number(o.obsTime)!=null ? o.obsTime*1000 : o.timestamp ? Date.parse(o.timestamp) : resolveDay(head[2],received);
  if(!Number.isFinite(t)||t>received||received-t>72*3600000)return null;
  const dt=new Date(t), h=head[2];
  if(dt.getUTCDate()!==+h.slice(0,2)||dt.getUTCHours()!==+h.slice(2,4)||dt.getUTCMinutes()!==+h.slice(4,6))return null;
  const rmk=raw.split(/\bRMK\b/)[1]||'';
  const tg=rmk.match(/(?:^|\s)T([01])(\d{3})[01]\d{3}(?:\s|$)/);
  const whole=raw.split(/\bRMK\b/)[0].match(/(?:^|\s)(M?\d{2})\/(M?\d{2}|\/)(?:\s|$)/);
  const c=tg?(tg[1]==='1'?-1:1)*+tg[2]/10 : whole?(whole[1][0]==='M'?-1:1)*+whole[1].replace('M',''):null;
  const sx=rmk.match(/(?:^|\s)1([01])(\d{3})(?:\s|$)/);
  const sixMaxC=sx?(sx[1]==='1'?-1:1)*+sx[2]/10:null;
  if((c==null&&sixMaxC==null)||(c!=null&&(c < -80 || c > 65)))return null;
  const wind=raw.match(/\b(\d{3}|VRB)(\d{2,3})(?:G(\d{2,3}))?KT\b/);
  return {id:hash([station,iso(t),raw]), station,t:iso(t),c,f:c==null?null:cToF(c),precise:!!tg,
    sixMaxC,raw,source,sourceUrl:url,receivedAt:iso(received),firstReceivedAt:iso(received),
    corrected:/\bCOR\b/.test(raw),windDir:wind&&wind[1]!=='VRB'?+wind[1]:null,
    windKt:wind?+wind[2]:null,wet:/\b[-+]?(?:TS|SH)?(?:RA|DZ|SN)\b/.test(raw),
    precisionC:tg?0.1:1, advisoryOnly:false};
}
function fromNWS(p,station,received,url,allowed) {
  if(!p || typeof p.rawMessage!=='string')return null;
  const parsed=parseMetar({rawOb:p.rawMessage,timestamp:p.timestamp,icaoId:station},'NWS',received,url,allowed);
  // Raw text required: never guess precision from a floating-point conversion in JSON.
  return parsed;
}
/** Keep conflicting versions for audit. COR beats original; unexplained numeric conflicts abstain. */
function selectRows(variants, asOf=Date.now()) {
  const groups=new Map();
  for(const r of variants||[]) {
    if(ms(r.t)>asOf||ms(r.firstReceivedAt||r.receivedAt)>asOf||r.advisoryOnly||r.omo||r.inferred)continue;
    const k=r.station+'|'+r.t;
    if(!groups.has(k))groups.set(k,[]); groups.get(k).push(r);
  }
  const out=[];
  for(const rs of groups.values()) {
    const corrected=rs.filter(r=>r.corrected);
    let a=corrected.length?corrected:rs;
    if(a.some(r=>r.precise))a=a.filter(r=>r.precise);
    const values=new Set(a.map(r=>JSON.stringify([r.c,r.sixMaxC])));
    const sameTemp=new Set(a.map(r=>r.c));
    // A missing extrema group is compatible with the same temperature plus an extrema group.
    const sx=new Set(a.filter(r=>r.sixMaxC!=null).map(r=>r.sixMaxC));
    if(sameTemp.size>1||sx.size>1){out.push({...a[0],conflict:true,variants:a.map(r=>r.id)});continue;}
    a.sort((x,y)=>ms(x.firstReceivedAt||x.receivedAt)-ms(y.firstReceivedAt||y.receivedAt));
    const best=a.find(r=>r.sixMaxC!=null)||a[0];out.push({...best,conflict:false});
  }
  return out.sort((a,b)=>ms(a.t)-ms(b.t));
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
module.exports={hash,ms,iso,number,cToF,date,allStations,validate,resolveDay,parseMetar,fromNWS,selectRows,parseDSM};
