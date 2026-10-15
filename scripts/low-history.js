'use strict';
const fs=require('node:fs'),path=require('node:path');
function metric(rows) {
  if(!rows.length)return null;
  const avg=fn=>rows.reduce((s,r)=>s+fn(r),0)/rows.length;
  return {n:rows.length,days:new Set(rows.map(r=>r.date)).size,mae:+avg(r=>Math.abs(r.point-r.actual)).toFixed(2),
    bias:+avg(r=>r.point-r.actual).toFixed(2),within1:+avg(r=>+(Math.abs(r.point-r.actual)<=1)).toFixed(3),
    cover80:+avg(r=>+(r.actual>=r.i80[0]&&r.actual<=r.i80[1])).toFixed(3),
    brier:+avg(r=>{let v=r.buckets.some(b=>b.f===r.actual)?0:1;for(const b of r.buckets)v+=(b.p-(b.f===r.actual?1:0))**2;return v;}).toFixed(4)};
}
function performance(rows,ledger) {
  const first=new Map();
  for(const r of rows.slice().sort((a,b)=>a.at.localeCompare(b.at))) {
    const actual=ledger[r.station]?.[r.date]?.min;
    if(!Number.isFinite(actual)||!Number.isFinite(r.point)||!Array.isArray(r.buckets)||!Array.isArray(r.i80))continue;
    const hour=Math.floor(r.localH);
    const checkpoint=r.dayOffset===1?(hour===18?'Day ahead · 18:00':null):({0:'00:00',7:'07:00',18:'18:00'}[hour]||null);
    if(!checkpoint)continue;
    const key=[r.modelVersion,r.station,r.date,checkpoint].join('|');
    if(!first.has(key))first.set(key,{...r,actual,checkpoint});
  }
  const groups=new Map();
  for(const r of first.values()) {const k=[r.modelVersion,r.station,r.checkpoint].join('|');if(!groups.has(k))groups.set(k,[]);groups.get(k).push(r);}
  return {generatedAt:new Date().toISOString(),metric:'low',method:'First call within each named local hour, once per station/date/checkpoint; final CLI minimum only. Highs never enter these scores.',
    minDaysBeforeReview:20,rows:[...groups.values()].map(r=>({station:r[0].station,modelVersion:r[0].modelVersion,checkpoint:r[0].checkpoint,...metric(r)}))};
}
function record(data,snap,ledger) {
  const dir=path.join(data,'low','history');fs.mkdirSync(dir,{recursive:true});
  for(const s of snap.stations||[]) {
    if(s.error||s.stale||!s.low||s.low.error)continue;
    const tz=s.station==='KMDW'?'America/Chicago':'America/New_York';
    const localH=Number(new Intl.DateTimeFormat('en-GB',{timeZone:tz,hour:'2-digit',hourCycle:'h23'}).format(new Date(snap.ranAt)));
    for(const [name,dayOffset] of [['today',0],['tomorrow',1]]) {
      const d=s.low[name];if(!d)continue;
      const row={station:s.station,at:snap.ranAt,localH,dayOffset,...d};
      fs.appendFileSync(path.join(dir,snap.ranAt.slice(0,7)+'.jsonl'),JSON.stringify(row)+'\n');
    }
  }
  const rows=[];
  for(const file of fs.readdirSync(dir).filter(f=>/^\d{4}-\d{2}\.jsonl$/.test(f)).sort())for(const line of fs.readFileSync(path.join(dir,file),'utf8').split('\n')) {
    if(!line.trim())continue;try{rows.push(JSON.parse(line));}catch{};
  }
  const p=path.join(data,'low','performance.json');fs.writeFileSync(p+'.tmp',JSON.stringify(performance(rows,ledger),null,1)+'\n');fs.renameSync(p+'.tmp',p);
}
module.exports={metric,performance,record};
