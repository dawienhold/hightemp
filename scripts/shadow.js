#!/usr/bin/env node
'use strict';
// Entry point. Does not import or modify the forecasting engine or its state.
const fs=require('node:fs'),path=require('node:path');
const {Collector,atomic}=require('./shadow/collector.js');
const root=path.join(__dirname,'..');
async function main() {
  const cfg=JSON.parse(fs.readFileSync(path.join(__dirname,'shadow','config.json'),'utf8'));
  const args=process.argv.slice(2);
  if(args.some(a=>a!=='--once')) throw new Error('Only optional --once is supported. This program cannot trade.');
  if(!cfg.enabled) {console.log('Shadow collector disabled in config; no changes made');return;}
  const out=path.join(root,'docs','data','shadow');fs.mkdirSync(out,{recursive:true});
  const lock=path.join(out,'.collector.lock');
  let handle;
  try {handle=fs.openSync(lock,'wx');} catch(e) {throw new Error('Another local shadow collector appears active; do not run two collectors together');}
  try {
    const collector=new Collector(root,cfg);
    const end=Date.now()+(args.includes('--once')?0:cfg.sessionSeconds)*1000;
    let samples=0,last=null;
    do {
      const start=Date.now();
      last=await collector.cycle();samples++;
      const next=start+cfg.pollSeconds*1000;
      if(next>end || Date.now()>end) break;
      await new Promise(r=>setTimeout(r,Math.max(0,next-Date.now())));
    } while(Date.now()<=end);
    console.log(`Shadow session complete: ${samples} sample(s). No real orders placed.`);
    if (!last?.discovery?.ok || last.errors.length) {
      console.error("One or more providers failed. Diagnostics were saved; forecast-pass is unaffected.");
      process.exitCode=1;
    }
  } finally {fs.closeSync(handle);fs.unlinkSync(lock);}
}
if(require.main===module) main().catch(e=>{
  console.error(e.stack||e);
  try {atomic(path.join(root,'docs','data','shadow','status.json'),{lastRunAt:new Date().toISOString(),ok:false,mode:'PAPER_ONLY',errors:[String(e.message||e)]});} catch {}
  process.exitCode=1;
});
module.exports={main};
