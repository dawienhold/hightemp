'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {buildPerformance,localHourAt}=require('../scripts/performance');
test('checkpoint review counts dates, not repeated passes, and separates versions',t=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'high-perf-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));fs.mkdirSync(path.join(dir,'history'));
  const r={st:'KPHL',date:'2026-10-14',at:'2026-10-14T11:01Z',point:70,localH:7.02,i80:[68,72],buckets:[{f:70,p:1}],biasTrack:true,modelVersion:'current'};
  const rows=[r,{...r,at:'2026-10-14T11:21Z',point:80},{...r,at:'2026-10-14T11:41Z',modelVersion:'old'}];
  fs.writeFileSync(path.join(dir,'history','2026-10.jsonl'),rows.map(JSON.stringify).join('\n'));
  const p=buildPerformance({KPHL:{'2026-10-14':{max:70}}},{},dir,'current');
  assert.equal(p.checkpoints[0].n,1);assert.equal(p.checkpoints[0].bias,0);assert.equal(p.versions.length,2);
  assert.equal(localHourAt('KPHL','2026-10-14T11:00Z'),7);
});
