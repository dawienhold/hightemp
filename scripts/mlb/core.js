'use strict';
// Pure baseball + forecast transformations. No gambling, account, or order code.
const H=3600000;
const finite=v=>typeof v==='number'&&Number.isFinite(v);
const num=v=>finite(v)?v:null;
const iso=v=>new Date(v).toISOString();
const round=(v,d=1)=>v==null?null:Math.round(v*10**d)/10**d;
function localDate(now,tz='America/New_York'){
 const p=new Intl.DateTimeFormat('en-CA',{timeZone:tz,year:'numeric',month:'2-digit',day:'2-digit'}).formatToParts(new Date(now));
 const get=t=>p.find(x=>x.type===t).value;return `${get('year')}-${get('month')}-${get('day')}`;
}
function addDays(date,n){return iso(Date.parse(date+'T12:00:00Z')+n*24*H).slice(0,10);}
function windMph(value,unit='mph'){
 if(value==null)return null;
 if(typeof value==='object')return windMph(value.value,value.unitCode||value.uom||unit);
 if(typeof value==='string'){
  if(/^(calm)$/i.test(value.trim()))return 0;
  const m=value.match(/^\s*(\d+(?:\.\d+)?)(?:\s*(?:to|-)\s*(\d+(?:\.\d+)?))?\s*(mph|km\/h|kph|kmh|kt|kts|knots|m\/s)\s*$/i);
  if(!m)return null;return windMph(Math.max(+m[1],+(m[2]||m[1])),m[3]);
 }
 if(!finite(value)||value<0)return null;
 unit=String(unit).toLowerCase();
 if(/mph|mi_h-1/.test(unit))return value;
 if(/km\/h|km_h-1|kmh|kph/.test(unit))return value/1.609344;
 if(/^(kt|kts|kn|knots)$/.test(unit)||/wmoUnit:kn/i.test(unit))return value*1.15077945;
 if(/m\/s|m_s-1/.test(unit))return value*2.23693629;
 return null;
}
function temperatureF(value,unit){
 if(!finite(value))return null;
 if(/^(f|fahrenheit)$|degF/i.test(unit||''))return value;
 if(/^(c|celsius)$|degC/i.test(unit||''))return value*1.8+32;
 return null;
}
function durationMs(s){
 const m=String(s).match(/^P(?:(\d+(?:\.\d+)?)D)?(?:T(?:(\d+(?:\.\d+)?)H)?(?:(\d+(?:\.\d+)?)M)?(?:(\d+(?:\.\d+)?)S)?)?$/);
 return m?((+m[1]||0)*86400+(+m[2]||0)*3600+(+m[3]||0)*60+(+m[4]||0))*1000:null;
}
function gridGusts(grid){
 const g=grid?.properties?.windGust;if(!g||!Array.isArray(g.values))return [];
 return g.values.map(x=>{const [t,d]=String(x.validTime).split('/'),start=Date.parse(t),span=durationMs(d);
  return {start,end:start+span,value:windMph(x.value,g.uom)};
 }).filter(x=>finite(x.start)&&x.end>x.start&&x.value!=null);
}
function nwsHours(hourly,grid){
 const p=hourly?.properties;if(!p||!Array.isArray(p.periods))throw Error('NWS hourly periods missing');
 const gusts=gridGusts(grid);
 const rows=p.periods.map(x=>{
  const start=Date.parse(x.startTime),end=Date.parse(x.endTime);
  const pop=x.probabilityOfPrecipitation?.value;
  const matched=gusts.filter(g=>g.start<end&&g.end>start);
  return {start,end,temperatureF:temperatureF(x.temperature,x.temperatureUnit),
    pop:finite(pop)&&pop>=0&&pop<=100?pop:null,windMph:windMph(x.windSpeed),
    gustMph:matched.length?Math.max(...matched.map(x=>x.value)):null,
    direction:typeof x.windDirection==='string'?x.windDirection:null,condition:String(x.shortForecast||'')};
 }).filter(x=>finite(x.start)&&finite(x.end)&&x.end>x.start).sort((a,b)=>a.start-b.start);
 return {provider:'NWS',issuedAt:p.updateTime||p.generatedAt||null,rows};
}
function roof(v){
 const s=String(v?.fieldInfo?.roofType||'').toLowerCase();
 if(/retract/.test(s))return 'retractable';
 if(/dome|fixed|indoor|enclosed/.test(s))return 'fixed';
 if(/open|outdoor/.test(s))return 'open';return 'unknown';
}
function venue(v){
 const c=v?.location?.defaultCoordinates||{},lat=num(c.latitude),lon=num(c.longitude);
 return {id:v?.id??null,name:v?.name||'Venue not provided',city:v?.location?.city||'',
  country:v?.location?.country||'',lat:lat!=null&&Math.abs(lat)<=90?lat:null,
  lon:lon!=null&&Math.abs(lon)<=180?lon:null,roof:roof(v),surface:v?.fieldInfo?.turfType||null};
}
function schedule(doc,now,lookaheadDays=5){
 if(!doc||!Array.isArray(doc.dates))throw Error('MLB schedule schema: dates array missing');
 const today=localDate(now),until=addDays(today,lookaheadDays-1),seen=new Map();
 for(const date of doc.dates)for(const x of date.games||[]){
  if(!Number.isSafeInteger(x.gamePk))continue;
  if(!['R','F','D','L','W'].includes(x.gameType))continue; // no mixed spring/exhibition rank claims
  const st=x.status||{},detail=String(st.detailedState||st.abstractGameState||'Unknown');
  if(st.abstractGameState==='Final'||/cancelled|canceled|final|completed/i.test(detail))continue;
  const start=Date.parse(x.gameDate),isLive=st.abstractGameState==='Live';
  const timingUncertain=!!x.startTimeTBD||!finite(start)||/postpon|suspend|delay/i.test(detail);
  const labelDate=x.officialDate||date.date;
  if(!labelDate||labelDate>until||(labelDate<today&&!isLive))continue;
  const side=key=>{const s=x.teams?.[key]||{},t=s.team||{};return {id:t.id??null,name:t.name||'Unknown team',abbr:t.abbreviation||t.teamCode||t.name||'?',
    probablePitcher:s.probablePitcher?.fullName||null,record:s.leagueRecord?`${s.leagueRecord.wins}-${s.leagueRecord.losses}`:null};};
  seen.set(x.gamePk,{id:String(x.gamePk),date:labelDate,startAt:finite(start)?iso(start):null,startTimeTBD:!!x.startTimeTBD,
    state:isLive?'live':'scheduled',status:detail,timingUncertain,doubleheader:x.doubleHeader&&x.doubleHeader!=='N'?x.gameNumber||null:null,
    gameType:x.gameType,season:Number(x.season)||Number(today.slice(0,4)),home:side('home'),away:side('away'),rawVenue:x.venue||{}});
 }
 return [...seen.values()].sort((a,b)=>(a.date.localeCompare(b.date))||String(a.startAt||'z').localeCompare(b.startAt||'z')||a.id.localeCompare(b.id));
}
function defense(doc,season,throughDate){
 if(!doc||!Array.isArray(doc.records))throw Error('MLB standings schema: records array missing');
 const map=new Map();
 for(const group of doc.records)for(const r of group.teamRecords||[]){
  if(group.season!=null&&String(group.season)!==String(season))continue;
  const id=r.team?.id,gp=num(r.gamesPlayed),ra=num(r.runsAllowed);
  if(!Number.isSafeInteger(id)||gp==null||gp<=0||ra==null||ra<0||!Number.isInteger(gp)||!Number.isInteger(ra))continue;
  map.set(id,{teamId:id,games:gp,runsAllowed:ra,raPerGame:ra/gp,runsScored:num(r.runsScored),season,throughDate,lastUpdated:r.lastUpdated||null});
 }
 const list=[...map.values()].sort((a,b)=>a.runsAllowed*b.games-b.runsAllowed*a.games||a.teamId-b.teamId);
 let rank=0;
 for(let i=0;i<list.length;i++){
  const r=list[i],prev=list[i-1];if(!prev||r.runsAllowed*prev.games!==prev.runsAllowed*r.games)rank=i+1;
  r.rank=rank;r.outOf=list.length;r.raPerGame=round(r.raPerGame,2);
 }
 return {season,throughDate,complete:list.length===30,teamCount:list.length,teams:Object.fromEntries(list.map(x=>[x.teamId,x])),
   note:'Regular-season runs allowed / games played. Lower is better; includes pitching and fielding, not a pure fielding or starting-pitcher rating.'};
}
function mergeCoverage(rows,start,end,field){
 const spans=rows.filter(r=>r[field]!=null).map(r=>[Math.max(start,r.start),Math.min(end,r.end)]).filter(r=>r[1]>r[0]).sort((a,b)=>a[0]-b[0]);
 let sum=0,last=null;
 for(const x of spans){if(!last)last=x.slice();else if(x[0]<=last[1])last[1]=Math.max(last[1],x[1]);else{sum+=last[1]-last[0];last=x.slice();}}
 if(last)sum+=last[1]-last[0];return sum/(end-start);
}
function gameWeather(forecast,game,now,gameHours=3.5){
 if(game.venue?.roof==='fixed')return {indoor:true,note:'Fixed roof: outdoor rain and wind are not applied to the playing field.'};
 if(game.timingUncertain||!game.startAt)return {unavailable:true,note:'Start time uncertain or game delayed/postponed. No exact weather window assumed.'};
 const first=Date.parse(game.startAt);let start=first,end=first+gameHours*H,windowLabel='First pitch through '+gameHours+' hours later';
 if(game.state==='live'&&now>start){start=now;windowLabel='Remaining forecast window (game in progress)';if(end<=now){end=now+1.5*H;windowLabel='Extended live game: next 1.5 hours';}}
 if(!forecast?.rows?.length)return {unavailable:true,note:'No usable hourly forecast received.'};
 const rows=forecast.rows.filter(r=>r.start<end&&r.end>start);
 if(!rows.length)return {unavailable:true,provider:forecast.provider,note:'The game window is outside the available hourly forecast. No weather values invented.'};
 const maximum=field=>{const v=rows.map(r=>r[field]).filter(finite);return v.length?Math.max(...v):null;};
 const windPeak=rows.filter(r=>r.windMph!=null).sort((a,b)=>b.windMph-a.windMph)[0];
 const coverage={pop:mergeCoverage(rows,start,end,'pop'),wind:mergeCoverage(rows,start,end,'windMph'),gust:mergeCoverage(rows,start,end,'gustMph')};
 const pop=maximum('pop'),wind=maximum('windMph'),gust=maximum('gustMph');
 return {provider:forecast.provider,issuedAt:forecast.issuedAt||null,receivedAt:forecast.receivedAt||null,sourceUrl:forecast.sourceUrl||null,
  stale:!!forecast.stale,windowStart:iso(start),windowEnd:iso(end),windowLabel,coverage,
  partial:coverage.pop<0.999||coverage.wind<0.999,
  peakHourlyPop:pop,maxSustainedMph:round(wind),maxGustMph:round(gust),windFrom:windPeak?.direction||null,
  temperatureAtStartF:round(rows[0].temperatureF),snowPossible:rows.some(r=>/snow|sleet|freezing/i.test(r.condition||'')),
  roofUnverified:game.venue?.roof==='retractable'||game.venue?.roof==='unknown',
  hourly:rows.map(r=>({...r,startAt:iso(r.start),endAt:iso(r.end),windMph:round(r.windMph),gustMph:round(r.gustMph),temperatureF:round(r.temperatureF)})),
  note:'Peak hourly precipitation probability, NOT the probability of any rain over the entire game. Wind is the forecast outside the ballpark; no home-run or in/out-to-center inference.'};
}
module.exports={H,finite,num,iso,round,localDate,addDays,windMph,temperatureF,durationMs,nwsHours,roof,venue,schedule,defense,gameWeather};
