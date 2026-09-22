'use strict';
const fs=require('node:fs'),path=require('node:path'),cp=require('node:child_process');
const C=require('./core');
const MLB='https://statsapi.mlb.com/api/v1',NWS='https://api.weather.gov';
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
function allowed(input){
 const u=new URL(input);
 if(u.protocol!=='https:'||u.username||u.password||u.port)throw Error('Unsupported source URL');
 const ok=(u.hostname==='statsapi.mlb.com'&&/^\/api\/v1\/(schedule|standings|venues)(?:\/\d+)?$/.test(u.pathname))||
  (u.hostname==='api.weather.gov'&&/^\/(points\/[-\d.,]+|gridpoints\/[A-Z]{3}\/\d+,\d+(?:\/forecast\/hourly)?)$/.test(u.pathname))||
  (u.hostname==='dd.weather.gc.ca'&&/^\/today\/citypage_weather\/ON\/\d{2}\/(?:[a-zA-Z0-9_.-]+\.xml)?$/.test(u.pathname));
 if(!ok)throw Error('Source allowlist rejected '+u.hostname+u.pathname);return u;
}
function network(transport=global.fetch){
 let tail=Promise.resolve(),last=0;
 return async(url,format='json')=>{
  const u=allowed(url);
  for(let attempt=0;attempt<2;attempt++){
   const gate=tail.then(async()=>{await sleep(Math.max(0,350-(Date.now()-last)));last=Date.now();});tail=gate.catch(()=>{});await gate;
   const r=await transport(u.href,{method:'GET',redirect:'error',headers:{Accept:format==='json'?'application/geo+json,application/json':'application/xml,text/xml,text/html','User-Agent':'hightemp-mlb-public-weather (github.com/dawienhold/hightemp)'},signal:AbortSignal.timeout(15000)});
   if((r.status===429||r.status>=500)&&attempt===0){const retry=Number(r.headers?.get('retry-after'));if(retry>10)throw Error('Source requests longer backoff');await sleep(Math.max(1000,(retry||1)*1000));continue;}
   if(!r.ok)throw Error(`HTTP ${r.status} ${u.hostname}${u.pathname}`);
   return {data:format==='json'?await r.json():await r.text(),receivedAt:C.iso(Date.now()),url:u.href};
  }
  throw Error('Source unavailable');
 };
}
function readJSON(file,fallback){try{return JSON.parse(fs.readFileSync(file,'utf8'));}catch(e){if(e.code==='ENOENT')return fallback;throw Error('Unreadable saved MLB data; not resetting: '+file);}}
function atomic(file,data){fs.mkdirSync(path.dirname(file),{recursive:true});fs.writeFileSync(file+'.tmp',JSON.stringify(data)+'\n');fs.renameSync(file+'.tmp',file);}
class MLBCollector{
 constructor(root,{reader,now=Date.now()}={}){
  this.root=root;this.now=now;this.reader=reader||network();this.out=path.join(root,'docs','data','mlb');
  this.cache=readJSON(path.join(this.out,'cache.json'),{schemaVersion:1,entries:{}});
  if(this.cache.schemaVersion!==1)throw Error('Unsupported MLB cache schema');
  this.errors=[];this.warnings=[];
 }
 async get(url,ttl=0,{format='json',project=null}={}){
  const old=this.cache.entries[url];
  if(old&&this.now-Date.parse(old.receivedAt)<ttl)return {...old,cached:true};
  const r=await this.reader(url,format);const value={data:project?project(r.data):r.data,receivedAt:r.receivedAt||C.iso(this.now),url};
  if(ttl)this.cache.entries[url]=value;return value;
 }
 async forecastNWS(v){
  const u=`${NWS}/points/${v.lat.toFixed(4)},${v.lon.toFixed(4)}`;
  const point=await this.get(u,7*86400000),p=point.data?.properties;
  if(!p?.forecastHourly)throw Error('NWS point has no hourly forecast URL');
  allowed(p.forecastHourly);
  const hourly=await this.get(p.forecastHourly,35*60000);let grid=null;
  if(p.forecastGridData){
   try{allowed(p.forecastGridData);const r=await this.get(p.forecastGridData,35*60000,{project:x=>({properties:{windGust:x.properties?.windGust}})});grid=r.data;}
   catch(e){this.warnings.push(`${v.name}: gust forecast unavailable (${e.message})`);}
  }
  return {...C.nwsHours(hourly.data,grid),receivedAt:hourly.receivedAt,sourceUrl:p.forecastHourly};
 }
 async forecastToronto(v){
  // ECCC's official dated XML directory, not a paid/private provider.
  // Fixed station code is additionally verified by the XML's Toronto name.
  const cacheKey='toronto-normalized';const old=this.cache.entries[cacheKey];
  if(old&&this.now-Date.parse(old.receivedAt)<35*60000)return old.data;
  let lastError='No recent Toronto city XML located';
  for(let back=0;back<4;back++){
   const t=new Date(this.now-back*C.H),hour=String(t.getUTCHours()).padStart(2,'0');
   const url=`https://dd.weather.gc.ca/today/citypage_weather/ON/${hour}/`;
   try{
    const list=await this.get(url,0,{format:'text'});
    const candidates=[...list.data.matchAll(/href=["']([^"']+MSC_CitypageWeather_s0000458_en\.xml)["']/g)]
      .map(m=>m[1]).filter(n=>/^[0-9]{8}T[0-9.]+Z_MSC_CitypageWeather_s0000458_en\.xml$/.test(n)).sort().reverse();
    for(const filename of candidates.slice(0,2)){
     const xml=await this.get(url+filename,0,{format:'text'});
     const r=cp.spawnSync(process.env.PYTHON||'python3',[path.join(this.root,'scripts','mlb_canada.py')],{input:xml.data,encoding:'utf8',timeout:10000,maxBuffer:3*1024*1024});
     if(r.error||r.status!==0)throw Error(r.error?.message||String(r.stderr).trim()||'Toronto XML conversion failed');
     const data={...JSON.parse(r.stdout),receivedAt:xml.receivedAt,sourceUrl:url+filename};
     if(!data.rows?.some(x=>x.end>this.now))continue;
     this.cache.entries[cacheKey]={receivedAt:xml.receivedAt,data};return data;
    }
   }catch(e){lastError=e.message;}
  }
  throw Error(lastError);
 }
 async forecast(v){
  if(v.lat==null||v.lon==null)throw Error('Ballpark coordinates missing in MLB venue data');
  const key='forecast:'+v.id;let result;
  try{
   const toronto=v.lat>43.5&&v.lat<44&&v.lon>-79.8&&v.lon<-79;
   result=toronto?await this.forecastToronto(v):await this.forecastNWS(v);
   this.cache.entries[key]={receivedAt:result.receivedAt,data:result};return result;
  }catch(e){
   const old=this.cache.entries[key];
   if(old&&this.now-Date.parse(old.receivedAt)<=2*C.H){this.errors.push(`${v.name}: using cached forecast after ${e.message}`);return {...old.data,stale:true};}
   throw e;
  }
 }
 async run(){
  const date=C.localDate(this.now),end=C.addDays(date,4),start=C.addDays(date,-1),season=Number(date.slice(0,4)),through=C.addDays(date,-1);
  const scheduleUrl=`${MLB}/schedule?sportId=1&startDate=${start}&endDate=${end}&hydrate=team,venue(location,fieldInfo),probablePitcher`;
  const r=await this.get(scheduleUrl),games=C.schedule(r.data,this.now,5);
  const standingsUrl=`${MLB}/standings?leagueId=103,104&season=${season}&standingsTypes=regularSeason&date=${through}`;
  let defensive={season,throughDate:through,teams:{},teamCount:0,complete:false};
  try{const s=await this.get(standingsUrl,4*C.H);defensive={...C.defense(s.data,season,through),sourceUrl:standingsUrl,receivedAt:s.receivedAt};}
  catch(e){this.errors.push('Runs-allowed standings unavailable: '+e.message);}
  if(!defensive.complete)this.warnings.push(`Defensive data covers ${defensive.teamCount}/30 teams; missing teams are not assigned zero or ranked.`);
  const venues=new Map(games.map(g=>[g.rawVenue.id,g.rawVenue]));
  const missing=[...venues].filter(([id,v])=>id&&(!v.location?.defaultCoordinates||!v.fieldInfo)).map(([id])=>id);
  for(let i=0;i<missing.length;i+=30){
   const ids=missing.slice(i,i+30).join(',');
   try{const q=await this.get(`${MLB}/venues?venueIds=${ids}&hydrate=location,fieldInfo`,7*86400000);
    if(!Array.isArray(q.data.venues))throw Error('Venue response missing venues');
    for(const v of q.data.venues)venues.set(v.id,{...venues.get(v.id),...v});
   }catch(e){this.errors.push('Venue detail unavailable: '+e.message);}
  }
  const forecasts=new Map();
  for(const g of games){
   g.venue=C.venue(venues.get(g.rawVenue.id)||g.rawVenue);delete g.rawVenue;
   g.home.defense=defensive.teams[g.home.id]||null;g.away.defense=defensive.teams[g.away.id]||null;
   if(g.venue.roof!=='fixed'&&!g.timingUncertain&&!forecasts.has(g.venue.id)){
    try{forecasts.set(g.venue.id,await this.forecast(g.venue));}
    catch(e){forecasts.set(g.venue.id,{error:e.message});this.errors.push(`${g.venue.name}: ${e.message}`);}
   }
   const f=forecasts.get(g.venue.id);
   g.weather=C.gameWeather(f,g,this.now,3.5);
   if(f?.error&&g.weather.unavailable)g.weather.note=f.error;
   g.url=`https://www.mlb.com/gameday/${g.id}`;
  }
  // Drop old cache entries only in the NEW MLB namespace, never forecast/shadow history.
  for(const [key,x] of Object.entries(this.cache.entries))if(this.now-Date.parse(x.receivedAt)>14*86400000)delete this.cache.entries[key];
  const snap={schemaVersion:1,version:'1.0.0',title:'MLB',generatedAt:C.iso(this.now),scheduleReceivedAt:r.receivedAt,
   displayTimezone:'America/New_York',window:{start:date,end,days:5},games,defense:{...defensive,teams:undefined},
   sources:{schedule:scheduleUrl,standings:standingsUrl,weather:'NWS hourly/grid forecasts; ECCC Toronto XML when available'},
   errors:[...new Set(this.errors)],warnings:[...new Set(this.warnings)],
   note:'Weather is not a postponement prediction. RA/G includes pitching and fielding, not just defense. Retractable roof position is unverified.'};
  atomic(path.join(this.out,'cache.json'),this.cache);atomic(path.join(this.out,'latest.json'),snap);
  const status={lastRunAt:snap.generatedAt,ok:this.errors.length===0,partial:this.errors.length>0,games:games.length,errors:snap.errors,warnings:snap.warnings};
  atomic(path.join(this.out,'status.json'),status);fs.appendFileSync(path.join(this.out,'runs.jsonl'),JSON.stringify(status)+'\n');
  return snap;
 }
}
module.exports={MLBCollector,network,allowed,atomic,readJSON};
