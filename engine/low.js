'use strict';
// Daily MINIMUM model. Deliberately independent of the high model's biases,
// peak-time heuristics and hidden-peak probabilities. Every interval is UTC
// midnight-to-midnight LOCAL STANDARD TIME, including the following 00:00 DST.
const HOUR = 3600000;
const VERSION = 'low-1.0.0';
const OFFSETS = {'America/New_York':-5,'America/Chicago':-6};
const finite = Number.isFinite;
const median = a => {const s=a.filter(finite).sort((a,b)=>a-b),m=s.length>>1;return s.length?(s.length%2?s[m]:(s[m-1]+s[m])/2):null;};
const clamp = (x,a,b) => Math.max(a,Math.min(b,x));
function windowFor(date,tz) {
  if(OFFSETS[tz]==null)throw Error('Unsupported low station timezone');
  const start=Date.parse(date+'T00:00:00Z')-OFFSETS[tz]*HOUR;
  return {start,end:start+24*HOUR};
}
function climateDate(ms,tz) {return new Date(ms+OFFSETS[tz]*HOUR).toISOString().slice(0,10);}
function aggregate(hourly,models,tz,key='temperature_2m') {
  const out={};
  for(const m of models) {
    const rows=hourly[key+'_'+m]||[],days={};
    (hourly.time||[]).forEach((t,i)=>{
      if(!finite(rows[i]))return;
      const date=climateDate(Date.parse(t+'Z'),tz);
      (days[date]??=[]).push(rows[i]);
    });
    // A partial UTC boundary must never masquerade as a daily minimum.
    out[m]=Object.fromEntries(Object.entries(days).filter(([,v])=>v.length>=24).map(([d,v])=>[d,Math.min(...v)]));
  }
  return out;
}
function calibrate(analysis,previous,cli,date,models) {
  const truth=new Map(cli.filter(r=>r.date<date&&finite(r.min)).map(r=>[r.date,r.min]));
  const result={models:{},days:truth.size,minDays:8,priorDays:20,capF:1.5};
  for(const m of models) {
    const errors=Object.entries(analysis[m]||{}).filter(([d,v])=>truth.has(d)&&finite(v)).map(([d,v])=>truth.get(d)-v);
    const skill=Object.entries(previous[m]||{}).filter(([d,v])=>truth.has(d)&&finite(v)).map(([d,v])=>truth.get(d)-v);
    const n=errors.length,raw=median(errors)||0;
    const bias=n>=8?clamp(raw*n/(n+20),-1.5,1.5):0;
    const center=median(skill)||0,spread=median(skill.map(e=>Math.abs(e-center)));
    const sd=skill.length>=8&&finite(spread)?Math.sqrt((skill.length*(Math.max(1.5,1.4826*spread)**2)+20*2.8**2)/(skill.length+20)):2.8;
    result.models[m]={n,nSkill:skill.length,rawBias:raw,bias,sd};
  }
  return result;
}
function sixHourMinC(raw) {
  const m=String(raw||'').split(/\bRMK\b/)[1]?.match(/(?:^|\s)2([01])(\d{3})(?:\s|$)/);
  return m?(m[1]==='1'?-1:1)*Number(m[2])/10:null;
}
function observedMinimum(obs,date,tz,now) {
  const {start,end}=windowFor(date,tz);let upper=null,best=null,precise=null,count=0;
  for(const r of obs||[]) {
    const t=+new Date(r.t);
    if(t<start||t>=end||t>now||r.inferred||r.omo||r.advisoryOnly||r.structured||r.conflict)continue;
    const take=(f,slack,source)=>{
      if(!finite(f))return;
      count++;
      const ceil=f+slack;
      if(upper==null||ceil<upper){upper=ceil;best={f,band:[f-slack,ceil],at:new Date(t).toISOString(),source,precise:slack<0.1};}
      if(slack<0.1&&(precise==null||f<precise))precise=f;
    };
    take(r.f,r.precise?0.05:0.9,r.precise?'METAR tenths':'METAR whole °C');
    const six=finite(r.sixMinC)?r.sixMinC:sixHourMinC(r.raw);
    const syn=Math.round(t/(6*HOUR))*6*HOUR;
    if(finite(six)&&syn-6*HOUR>=start&&syn<=end)take(six*1.8+32,0.05,'6-hour minimum group');
  }
  return {upper,best,precise,count};
}
function distribution(mu,sd,ceiling,cdf) {
  const lo=Math.floor(mu-6*sd),hi=Math.min(Math.ceil(mu+6*sd),ceiling??Infinity),b=[];
  for(let f=Math.min(lo,hi);f<=hi;f++)b.push({f,p:Math.max(0,cdf((f+0.5-mu)/sd)-cdf((f-0.5-mu)/sd))});
  const sum=b.reduce((s,x)=>s+x.p,0);
  if(!(sum>0))return [{f:Math.round(ceiling??mu),p:1}];
  return b.map(x=>({f:x.f,p:x.p/sum}));
}
function forecast(st,{hourly,models,cal,obs,cli,now,cdf,labels},date,offset) {
  const {start,end}=windowFor(date,st.tz),times=hourly.time.map(t=>Date.parse(t+'Z'));
  const indices=times.map((t,i)=>t>=start&&t<end?i:-1).filter(i=>i>=0);
  const seen=offset===0?observedMinimum(obs,date,st.tz,now):{upper:null,best:null,count:0};
  const prelim=offset===0?(cli.prelim||[]).find(r=>r.date===date&&finite(r.min)&&Date.parse(r.issued)<=now):null;
  const upper=prelim?Math.min(seen.upper??Infinity,prelim.min):seen.upper;
  const candidates=[];
  for(const m of models) {
    const arr=hourly['temperature_2m_'+m]||[],valid=indices.filter(i=>finite(arr[i]));
    if(valid.length<24)continue;
    const remaining=valid.filter(i=>offset!==0||times[i]>=now-HOUR/2);
    if(!remaining.length)continue;
    const bias=cal.models[m]?.bias||0,errs=[];
    if(offset===0)for(const r of obs||[]) {
      const t=+new Date(r.t);
      if(!finite(r.f)||t<Math.max(start,now-3*HOUR)||t>now||r.inferred||r.omo||r.advisoryOnly||r.structured||r.conflict)continue;
      const i=valid.reduce((a,b)=>Math.abs(times[b]-t)<Math.abs(times[a]-t)?b:a,valid[0]);
      if(Math.abs(times[i]-t)<=35*60000)errs.push(r.f-arr[i]-bias);
    }
    const residual=clamp(median(errs)||0,-4,4);
    const v=remaining.map(i=>({f:arr[i]+bias+residual*Math.exp(-Math.max(0,times[i]-now)/(3*HOUR)),t:times[i]})).sort((a,b)=>a.f-b.f)[0];
    candidates.push({model:m,label:labels[m]||m,f:upper==null?v.f:Math.min(v.f,upper),remaining:v.f,at:new Date(v.t).toISOString(),bias,sd:cal.models[m]?.sd||2.8});
  }
  if(candidates.length<2)throw Error('Fewer than two models cover the complete climate day');
  const mu=median(candidates.map(x=>x.f)),spread=1.4826*(median(candidates.map(x=>Math.abs(x.f-mu)))||0);
  // No inherited high-temperature confidence shrink or high hidden-peak fit.
  // Until held-out LOW scores exist, retain an explicit uncertainty floor.
  const sd=Math.max(offset===0?1.8:2.8,Math.sqrt(spread**2+(median(candidates.map(x=>x.sd))||2.8)**2));
  const ceiling=upper==null?null:Math.round(upper);
  const buckets=distribution(mu,sd,ceiling,cdf),pick=q=>{let s=0;for(const b of buckets){s+=b.p;if(s>=q)return b.f;}return buckets.at(-1).f;};
  const expected=buckets.reduce((s,b)=>s+b.f*b.p,0),modal=buckets.reduce((a,b)=>a.p>b.p?a:b).f;
  return {metric:'low',modelVersion:VERSION,date,point:modal,expected:+expected.toFixed(1),modal,sigma:+sd.toFixed(2),i50:[pick(.25),pick(.75)],i80:[pick(.1),pick(.9)],
    buckets:buckets.map(b=>({f:b.f,p:+b.p.toFixed(6)})),models:candidates,provisional:true,settled:false,
    observation:seen.best,ceiling,prelim:prelim?{min:prelim.min,asOf:prelim.asOf,issued:prelim.issued}:null,
    remainingMin:+median(candidates.map(x=>x.remaining)).toFixed(1),
    window:{start:new Date(start).toISOString(),end:new Date(end).toISOString(),basis:'NWS local standard time'},
    warning:'New low model: conservative probabilities; no validated low-temperature accuracy record yet.'};
}
async function runStation(st,{getJSON,models,labels,obs,cli,now,cdf}) {
  const q=`latitude=${st.lat}&longitude=${st.lon}&elevation=${st.elev}&temperature_unit=fahrenheit&timezone=GMT&models=${models.join(',')}`;
  const [a,p]=await Promise.all([
    getJSON('https://api.open-meteo.com/v1/forecast?'+q+'&hourly=temperature_2m&past_days=31&forecast_days=4',10*60000),
    getJSON('https://previous-runs-api.open-meteo.com/v1/forecast?'+q+'&hourly=temperature_2m_previous_day1&past_days=28&forecast_days=1',60*60000).catch(()=>null)
  ]);
  if(!Array.isArray(a.hourly?.time))throw Error('Missing low hourly guidance');
  // Identical model series contribute once. Correlated feeds are never samples.
  const unique=[],seen=new Set();
  for(const m of models){const arr=a.hourly['temperature_2m_'+m];if(!arr?.some(finite))continue;const k=JSON.stringify(arr);if(!seen.has(k)){seen.add(k);unique.push(m);}}
  const date=climateDate(now,st.tz),analysis=aggregate(a.hourly,unique,st.tz),previous=p?.hourly?aggregate(p.hourly,unique,st.tz,'temperature_2m_previous_day1'):{};
  const cal=calibrate(analysis,previous,cli,date,unique),ctx={hourly:a.hourly,models:unique,cal,obs,cli,now,cdf,labels};
  const tomorrow=new Date(Date.parse(date+'T12:00:00Z')+24*HOUR).toISOString().slice(0,10);
  return {ranAt:new Date(now).toISOString(),modelVersion:VERSION,calibration:cal,today:forecast(st,ctx,date,0),tomorrow:forecast(st,ctx,tomorrow,1)};
}
module.exports={VERSION,windowFor,climateDate,aggregate,calibrate,sixHourMinC,observedMinimum,distribution,forecast,runStation};
