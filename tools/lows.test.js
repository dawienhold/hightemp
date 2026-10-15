'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict');
const L=require('../engine/low'),HT=require('../engine/engine'),P=require('../scripts/low-history');
test('climate day uses standard-time boundary through DST changes',()=>{
  assert.deepEqual(L.windowFor('2026-10-15','America/New_York'),{start:Date.parse('2026-10-15T05:00Z'),end:Date.parse('2026-10-16T05:00Z')});
  assert.equal(L.climateDate(Date.parse('2026-10-16T04:30Z'),'America/New_York'),'2026-10-15');
  for(const d of ['2026-03-08','2026-11-01']){const w=L.windowFor(d,'America/Chicago');assert.equal(w.end-w.start,24*3600000);}
});
test('six-hour minimum parses sign and rejects wrong-day windows, proxies and future observations',()=>{
  const now=Date.parse('2026-10-15T20:00Z');
  assert.equal(L.sixHourMinC('RMK AO2 21017'),-1.7);
  const rows=[{t:'2026-10-15T11:53Z',f:60,precise:true,raw:'RMK AO2 20100'},
    {t:'2026-10-15T05:53Z',f:63,precise:true,raw:'RMK AO2 20000'},
    {t:'2026-10-15T12:00Z',f:20,precise:true,inferred:true},
    {t:'2026-10-15T12:05Z',f:10,precise:true,structured:true},
    {t:'2026-10-15T21:00Z',f:0,precise:true}];
  const seen=L.observedMinimum(rows,'2026-10-15','America/New_York',now);
  assert.equal(seen.best.f,50);assert.equal(seen.best.source,'6-hour minimum group');
  assert(seen.upper<51&&seen.upper>50);
});
test('coarse minimum gives an upper bound, not an exact Fahrenheit low',()=>{
  const seen=L.observedMinimum([{t:'2026-10-15T10:00Z',f:50,precise:false}], '2026-10-15','America/New_York',Date.parse('2026-10-15T12:00Z'));
  assert.equal(seen.upper,50.9);assert.equal(seen.best.precise,false);
});
test('low calibration needs independent dates, shrinks and caps; highs never enter',()=>{
  const analysis={a:{}},prev={a:{}},cli=[];
  for(let i=1;i<=8;i++){const date='2026-10-'+String(i).padStart(2,'0');analysis.a[date]=40;prev.a[date]=40;cli.push({date,min:50,max:99});}
  assert.equal(L.calibrate(analysis,prev,cli.slice(0,7),'2026-10-15',['a']).models.a.bias,0);
  const c=L.calibrate(analysis,prev,cli,'2026-10-15',['a']);assert.equal(c.models.a.bias,1.5);assert.equal(c.models.a.n,8);
  assert.equal(L.calibrate(analysis,prev,cli.map(r=>({...r,min:null})),'2026-10-15',['a']).models.a.bias,0);
});
test('partial climate days are not used as calibration minimums',()=>{
  const t=Array.from({length:24},(_,i)=>new Date(Date.parse('2026-10-15T05:00Z')+i*3600000).toISOString().slice(0,16));
  assert.equal(L.aggregate({time:t,temperature_2m_a:t.map(()=>50)},['a'],'America/New_York').a['2026-10-15'],50);
  assert.equal(L.aggregate({time:t.slice(0,23),temperature_2m_a:t.map(()=>50)},['a'],'America/New_York').a['2026-10-15'],undefined);
});
test('evening front can set the daily low after the morning minimum; next-day 00 DST counts',()=>{
  const start=Date.parse('2026-10-15T05:00Z'),time=Array.from({length:48},(_,i)=>new Date(start+i*3600000).toISOString().slice(0,16));
  const values=time.map((_,i)=>i===23?40:60),hourly={time,temperature_2m_a:values,temperature_2m_b:values.map(v=>v+1)};
  const st={tz:'America/New_York'};const ctx={hourly,models:['a','b'],cal:{models:{}},obs:[{t:'2026-10-15T11:00Z',f:50,precise:true}],cli:[],now:Date.parse('2026-10-15T16:00Z'),cdf:HT.normCdf,labels:{}};
  const out=L.forecast(st,ctx,'2026-10-15',0);
  assert.equal(out.remainingMin,40.5);assert(out.point<45);assert(out.buckets.every(b=>b.f<=50));assert.equal(out.settled,false);
  assert(Math.abs(out.buckets.reduce((s,b)=>s+b.p,0)-1)<.00001);
  assert.throws(()=>L.forecast(st,{...ctx,hourly:{...hourly,time:time.slice(0,23)}},'2026-10-15',0),/complete climate day/);
});
test('high Brier includes missing truth and uses all distribution buckets',()=>{
  const c={point:70,i80:[68,72],top:[{f:70,p:.9}],buckets:[{f:70,p:.9},{f:75,p:.1}]};
  assert.equal(HT.scoreCalls([c],75)[0].brier,1.62);
  assert.equal(HT.scoreCalls([{...c,buckets:undefined}],75)[0].brier,1.81);
});
test('low scores stay separate, use final minima and count each daily checkpoint once',()=>{
  const r={station:'KNYC',date:'2026-10-15',at:'2026-10-15T11:00Z',localH:7,dayOffset:0,point:50,i80:[48,52],buckets:[{f:50,p:1}],modelVersion:L.VERSION};
  assert.equal(P.performance([r,r],{KNYC:{'2026-10-15':{max:70}}}).rows.length,0);
  const out=P.performance([r,{...r,at:'2026-10-15T11:20Z'}],{KNYC:{'2026-10-15':{max:70,min:50}}});
  assert.equal(out.rows[0].n,1);assert.equal(out.rows[0].mae,0);
});
test('Philadelphia is connected to forecasts, input collection and market discovery',()=>{
  assert(HT.STATIONS.some(s=>s.id==='KPHL'&&s.cli==='PHL'));
  const O=require('../scripts/observations/core'),cfg=require('../scripts/observations/config');
  assert(O.validate(cfg));assert(O.allStations(cfg).includes('KPHL'));
  const core=require('../scripts/openings/core');assert.equal(core.ZONES.KPHL,'America/New_York');
});
