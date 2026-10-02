#!/usr/bin/env node
'use strict';
const fs=require('node:fs'),path=require('node:path');
const {Collector}=require('./openings/collector.js');
const {atomic}=require('./consistency/collector.js');
async function main() {
  if(process.argv.length>2)throw new Error('This collector only observes public quotes; no command arguments are supported');
  const root=path.join(__dirname,'..'),out=path.join(root,'docs/data/openings');fs.mkdirSync(out,{recursive:true});
  const lock=path.join(out,'.openings.lock'),handle=fs.openSync(lock,'wx');
  try {
    const snap=await new Collector(root,require('./openings/config.json')).run();
    console.log(JSON.stringify({at:snap.generatedAt,health:snap.health,events:snap.events.length,waiting:snap.waiting,errors:snap.errors,warnings:snap.warnings}));
    if(snap.errors.length)process.exitCode=1;
  }finally{fs.closeSync(handle);fs.unlinkSync(lock);}
}
if(require.main===module)main().catch(e=>{console.error(e.stack||e);try{atomic(path.join(__dirname,'../docs/data/openings/status.json'),{generatedAt:new Date().toISOString(),health:'FAILED',errors:[e.message]});}catch{}process.exitCode=1;});
module.exports={main};
