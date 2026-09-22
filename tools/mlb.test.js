'use strict';
// Synthetic offline fixtures. These are NOT observations of actual games/weather.
const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const C=require('../scripts/mlb/core');
const {MLBCollector,allowed,network}=require('../scripts/mlb/collector');
const NOW=Date.parse('2026-09-22T15:00:00Z'),H=3600000;
const park=(id=1,roofType='Open')=>({id,name:'Synthetic Park '+id,location:{city:'Test City',country:'USA',defaultCoordinates:{latitude:39.28,longitude:-76.62}},fieldInfo:{roofType,turfType:'Grass'}});
const game=(id=1,override={})=>({gamePk:id,gameType:'R',gameDate:'2026-09-22T17:30:00Z',officialDate:'2026-09-22',season:'2026',doubleHeader:'N',status:{abstractGameState:'Preview',detailedState:'Scheduled'},venue:park(),teams:{away:{team:{id:1,name:'Synthetic Away',abbreviation:'AWY'}},home:{team:{id:2,name:'Synthetic Home',abbreviation:'HME'}}},...override});
const scheduleDoc=games=>({dates:[{date:'2026-09-22',games}]});
const standingsDoc=()=>({records:[{season:'2026',teamRecords:[{team:{id:1},gamesPlayed:100,runsAllowed:400,runsScored:700},{team:{id:2},gamesPlayed:100,runsAllowed:500,runsScored:300}]}]});
const hourlyDoc=()=>({properties:{updateTime:'2026-09-22T14:00:00Z',periods:Array.from({length:12},(_,i)=>({startTime:C.iso(NOW+i*H),endTime:C.iso(NOW+(i+1)*H),temperature:70+i,temperatureUnit:'F',probabilityOfPrecipitation:{value:i===3?60:20},windSpeed:'5 to 10 mph',windDirection:'NW',shortForecast:'Chance of rain'}))}});
const gustDoc=()=>({properties:{windGust:{uom:'wmoUnit:km_h-1',values:[{validTime:'2026-09-22T15:00:00Z/PT12H',value:32.18688}]}}});
const readerFor=({games=[game()],failNWS=false,failStandings=false,missingMetadata=false}={})=>async url=>{
 const u=new URL(url);let data;
 if(u.pathname.endsWith('/schedule'))data=scheduleDoc(games);
 else if(u.pathname.endsWith('/standings')){if(failStandings)throw Error('fixture stats unavailable');data=standingsDoc();}
 else if(u.pathname.endsWith('/venues'))data={venues:[park()]};
 else if(u.hostname==='api.weather.gov'){
  if(failNWS)throw Error('fixture weather unavailable');
  if(u.pathname.startsWith('/points/'))data={properties:{forecastHourly:'https://api.weather.gov/gridpoints/LWX/90,80/forecast/hourly',forecastGridData:'https://api.weather.gov/gridpoints/LWX/90,80'}};
  else data=u.pathname.endsWith('/forecast/hourly')?hourlyDoc():gustDoc();
 }else throw Error('Unexpected test URL '+url);
 return {data,receivedAt:C.iso(NOW),url};
};
function tempRoot(t){const root=fs.mkdtempSync(path.join(os.tmpdir(),'hightemp-mlb-test-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));return root;}

test('wind ranges use upper forecast value; missing never equals calm',()=>{
 assert.equal(C.windMph('5 to 10 mph'),10);assert.equal(C.windMph('Calm'),0);assert.equal(C.windMph(null),null);assert.equal(C.windMph('Variable'),null);assert.equal(C.windMph(-3),null);
});
test('wind units are converted and unknown units rejected',()=>{
 assert.ok(Math.abs(C.windMph(16.09344,'wmoUnit:km_h-1')-10)<1e-8);assert.ok(Math.abs(C.windMph(10,'knots')-11.5077945)<1e-8);assert.equal(C.windMph(10,'unknown'),null);assert.equal(C.windMph({value:10,unitCode:'wmoUnit:mi_h-1'}),10);
});
test('temperature and duration unit conversions preserve nulls',()=>{
 assert.equal(C.temperatureF(0,'C'),32);assert.equal(C.temperatureF(null,'F'),null);assert.equal(C.temperatureF(10,'Kelvin'),null);assert.equal(C.durationMs('P1DT1H30M'),25.5*H);assert.equal(C.durationMs('PT6H'),6*H);assert.equal(C.durationMs('bad'),null);
});
test('NWS hourly precipitation and grid gust parsed independently',()=>{
 const f=C.nwsHours(hourlyDoc(),gustDoc());assert.equal(f.rows[3].pop,60);assert.ok(Math.abs(f.rows[0].gustMph-20)<1e-8);assert.equal(f.rows[0].windMph,10);
});
test('missing or invalid NWS percentages and gusts remain unknown',()=>{
 const d=hourlyDoc();d.properties.periods[0].probabilityOfPrecipitation.value=null;d.properties.periods[1].probabilityOfPrecipitation.value=101;
 const f=C.nwsHours(d,null);assert.equal(f.rows[0].pop,null);assert.equal(f.rows[1].pop,null);assert.equal(f.rows[0].gustMph,null);
});
test('actual venue coordinates and roof metadata used, not team home defaults',()=>{
 const v=C.venue(park(99,'Retractable'));assert.equal(v.id,99);assert.equal(v.roof,'retractable');assert.equal(v.lat,39.28);assert.equal(C.venue({id:99,name:'Relocated'}).lat,null);assert.equal(C.roof({}), 'unknown');
});
test('schedule keeps doubleheaders as separate games and deduplicates gamePk',()=>{
 const g=game(1,{doubleHeader:'Y',gameNumber:1}),h=game(2,{doubleHeader:'Y',gameNumber:2});
 const out=C.schedule(scheduleDoc([g,h,g]),NOW);assert.equal(out.length,2);assert.equal(out[1].doubleheader,2);
});
test('postponed and time-TBD games are flagged without invented weather window',()=>{
 for(const g of [game(1,{startTimeTBD:true}),game(2,{status:{detailedState:'Postponed'}})]){
  const x=C.schedule(scheduleDoc([g]),NOW)[0];assert.equal(x.timingUncertain,true);assert.equal(C.gameWeather(C.nwsHours(hourlyDoc()),x,NOW).unavailable,true);
 }
});
test('schedule drops finals/cancelled/spring games and dates outside next five days',()=>{
 const list=[game(1,{status:{abstractGameState:'Final'}}),game(2,{gameType:'S'}),game(3,{officialDate:'2026-09-27'}),game(4,{status:{detailedState:'Cancelled'}}),game(5)];
 assert.deepEqual(C.schedule(scheduleDoc(list),NOW).map(x=>x.id),['5']);
});
test('previous-date game still in progress remains visible',()=>{
 assert.equal(C.schedule({dates:[{date:'2026-09-21',games:[game(1,{officialDate:'2026-09-21',status:{abstractGameState:'Live',detailedState:'In Progress'}})]}]},NOW).length,1);
});
test('runs allowed, not runs scored or ERA, defines defense rating',()=>{
 const d=C.defense(standingsDoc(),2026,'2026-09-21');assert.equal(d.teams[1].raPerGame,4);assert.equal(d.teams[2].raPerGame,5);assert.equal(d.teams[1].rank,1);assert.equal(d.complete,false);
});
test('defense excludes missing/zero-game records; ties get competition ranks',()=>{
 const data={records:[{season:'2026',teamRecords:[{team:{id:1},gamesPlayed:2,runsAllowed:8},{team:{id:2},gamesPlayed:4,runsAllowed:16},{team:{id:3},gamesPlayed:2,runsAllowed:12},{team:{id:4},gamesPlayed:0,runsAllowed:0},{team:{id:5},gamesPlayed:50}]}]};
 const d=C.defense(data,2026,'2026-09-21');assert.equal(d.teamCount,3);assert.equal(d.teams[1].rank,1);assert.equal(d.teams[2].rank,1);assert.equal(d.teams[3].rank,3);assert.equal(d.teams[4],undefined);
});
test('different-season standings do not masquerade as current statistics',()=>{
 const d=standingsDoc();d.records[0].season='2025';assert.equal(C.defense(d,2026,'2026-09-21').teamCount,0);
});
test('peak hourly precipitation is maximum, not independent-hour game probability',()=>{
 const g=C.schedule(scheduleDoc([game()]),NOW)[0];g.venue=C.venue(park());const w=C.gameWeather(C.nwsHours(hourlyDoc(),gustDoc()),g,NOW);
 assert.equal(w.peakHourlyPop,60);assert.ok(Math.abs(w.maxGustMph-20)<0.01);assert.equal(w.windFrom,'NW');assert.equal(w.coverage.pop,1);assert.match(w.note,/NOT the probability/);assert.equal(w.windowEnd,'2026-09-22T21:00:00.000Z');
});
test('partial forecasts expose coverage; missing values never turn into zeros',()=>{
 const f=C.nwsHours(hourlyDoc());f.rows=f.rows.slice(3,4);const g=C.schedule(scheduleDoc([game()]),NOW)[0];const w=C.gameWeather(f,g,NOW);
 assert.equal(w.partial,true);assert.ok(w.coverage.pop<1);assert.equal(w.maxGustMph,null);assert.equal(w.coverage.gust,0);
});
test('fixed roof is indoor and retractable is explicitly unverified',()=>{
 const g=C.schedule(scheduleDoc([game()]),NOW)[0];g.venue=C.venue(park(1,'Dome'));assert.equal(C.gameWeather(null,g,NOW).indoor,true);
 g.venue=C.venue(park(1,'Retractable'));assert.equal(C.gameWeather(C.nwsHours(hourlyDoc()),g,NOW).roofUnverified,true);
});
test('extended live games get a clearly labeled remaining window',()=>{
 const g=C.schedule(scheduleDoc([game(1,{gameDate:'2026-09-22T08:00:00Z',status:{abstractGameState:'Live',detailedState:'In Progress'}})]),NOW)[0];
 const w=C.gameWeather(C.nwsHours(hourlyDoc()),g,NOW);assert.equal(w.windowStart,C.iso(NOW));assert.equal(w.windowEnd,C.iso(NOW+1.5*H));assert.match(w.windowLabel,/Extended/);
});
test('out-of-horizon Toronto/game weather is unavailable, not extrapolated',()=>{
 const f={rows:[{start:NOW-H,end:NOW,pop:30,windMph:10}]};const g=C.schedule(scheduleDoc([game()]),NOW)[0];assert.equal(C.gameWeather(f,g,NOW).unavailable,true);
});
test('source allowlist rejects account, credentials, trading, and unrelated endpoints',()=>{
 for(const u of ['https://api.weather.gov/gridpoints/LWX/1,2/forecast/hourly','https://statsapi.mlb.com/api/v1/standings?leagueId=103,104','https://dd.weather.gc.ca/today/citypage_weather/ON/15/'])assert.doesNotThrow(()=>allowed(u));
 for(const u of ['http://statsapi.mlb.com/api/v1/schedule','https://user:secret@statsapi.mlb.com/api/v1/schedule','https://evil.example/api/v1/schedule','https://gateway.polymarket.us/v1/orders','https://api.weather.gov:443/../../account'])assert.throws(()=>allowed(u));
});
test('network transport is unsigned GET-only with explicit source request identification',async()=>{
 let call;const read=network(async(u,opt)=>{call={u,opt};return {ok:true,status:200,headers:new Headers(),json:async()=>({records:[]})};});await read('https://statsapi.mlb.com/api/v1/standings');assert.equal(call.opt.method,'GET');assert.ok(call.opt.headers['User-Agent']);assert.equal(call.opt.headers.Authorization,undefined);
});
test('collector writes only MLB namespace and preserves original forecast and shadow files',async t=>{
 const root=tempRoot(t);fs.mkdirSync(path.join(root,'docs/data/shadow'),{recursive:true});fs.writeFileSync(path.join(root,'docs/data/state.json'),'FORECAST SENTINEL');fs.writeFileSync(path.join(root,'docs/data/shadow/state.json'),'SHADOW SENTINEL');
 const c=new MLBCollector(root,{reader:readerFor(),now:NOW});const snap=await c.run();assert.equal(snap.games.length,1);assert.equal(snap.games[0].home.defense.raPerGame,5);assert.equal(snap.games[0].weather.peakHourlyPop,60);assert.ok(fs.existsSync(path.join(root,'docs/data/mlb/latest.json')));
 assert.equal(fs.readFileSync(path.join(root,'docs/data/state.json'),'utf8'),'FORECAST SENTINEL');assert.equal(fs.readFileSync(path.join(root,'docs/data/shadow/state.json'),'utf8'),'SHADOW SENTINEL');
});
test('weather failure leaves schedule and defense usable, weather unknown',async t=>{
 const root=tempRoot(t);const s=await new MLBCollector(root,{reader:readerFor({failNWS:true}),now:NOW}).run();assert.equal(s.games.length,1);assert.equal(s.games[0].weather.unavailable,true);assert.equal(s.games[0].away.defense.raPerGame,4);assert.ok(s.errors.length);
});
test('statistics failure never assigns default zero RA/G',async t=>{
 const root=tempRoot(t);const s=await new MLBCollector(root,{reader:readerFor({failStandings:true}),now:NOW}).run();assert.equal(s.games[0].away.defense,null);assert.equal(s.games[0].home.defense,null);assert.ok(s.errors.some(x=>x.includes('standings')));
});
test('fixed-roof game avoids external weather lookup',async t=>{
 const root=tempRoot(t);const read=readerFor({games:[game(1,{venue:park(2,'Dome')})],failNWS:true});const s=await new MLBCollector(root,{reader:read,now:NOW}).run();assert.equal(s.games[0].weather.indoor,true);assert.equal(s.errors.length,0);
});
test('fatal schedule schema failure retains last saved snapshot',async t=>{
 const root=tempRoot(t);const out=path.join(root,'docs/data/mlb');fs.mkdirSync(out,{recursive:true});fs.writeFileSync(path.join(out,'latest.json'),'PRESERVE');
 const c=new MLBCollector(root,{now:NOW,reader:async()=>({data:{},receivedAt:C.iso(NOW)})});await assert.rejects(c.run(),/schedule schema/);assert.equal(fs.readFileSync(path.join(out,'latest.json'),'utf8'),'PRESERVE');
});
test('venue hydration fills actual park data without changing team identities',async t=>{
 const root=tempRoot(t);const s=await new MLBCollector(root,{now:NOW,reader:readerFor({games:[game(1,{venue:{id:1,name:'Partial'}})]})}).run();assert.equal(s.games[0].venue.name,'Synthetic Park 1');assert.equal(s.games[0].away.id,1);
});
test('unreadable MLB cache fails instead of silently resetting research data',t=>{
 const root=tempRoot(t),out=path.join(root,'docs/data/mlb');fs.mkdirSync(out,{recursive:true});fs.writeFileSync(path.join(out,'cache.json'),'{broken');assert.throws(()=>new MLBCollector(root,{now:NOW}),/not resetting/);
});
