#!/usr/bin/env node
'use strict';
const fs=require('node:fs'),path=require('node:path');
const {ObservationCollector}=require('./observations/collector');
async function main(){
 const root=path.join(__dirname,'..'),cfg=require('./observations/config.json');
 if(!cfg.enabled){console.log('Observation collector disabled');return;}
 const dir=path.join(root,'docs/data/observations');fs.mkdirSync(dir,{recursive:true});const lock=path.join(dir,'.collector.lock');
 let handle;try{handle=fs.openSync(lock,'wx');}catch{throw Error('Observation collector already running; refusing concurrent writers');}
 let collector;const end=Date.now()+(process.argv.includes('--once')?0:cfg.sessionSeconds)*1000;
 try{collector=new ObservationCollector(root,cfg);let count=0,last;
  do{const start=Date.now();last=await collector.cycle();count++;console.log(JSON.stringify({observationCycle:count,at:last.generatedAt,trainingPairs:collector.state.training.length,health:last.health.ok}));
    const next=start+cfg.pollSeconds*1000;if(next>end||Date.now()>end)break;
    await new Promise(r=>setTimeout(r,Math.max(0,next-Date.now())));
  }while(Date.now()<=end);
  if(!last?.health.ok)process.exitCode=1;
 }finally{collector?.flush();fs.closeSync(handle);fs.unlinkSync(lock);}
}
if(require.main===module)main().catch(e=>{console.error(e.stack);process.exitCode=1;});
module.exports={main};
