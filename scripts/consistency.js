#!/usr/bin/env node
'use strict';
const fs=require('node:fs'),path=require('node:path');
const {Collector,atomic}=require('./consistency/collector.js');
const C=require('./consistency/core.js');
async function main(){
  if(process.argv.slice(2).length)throw new Error('No live/replay/order arguments are supported. This script only observes public data.');
  const root=path.join(__dirname,'..');
  const cfg=C.validateConfig(JSON.parse(fs.readFileSync(path.join(__dirname,'consistency','config.json'),'utf8')));
  if(!cfg.enabled){console.log('Consistency scanner disabled; no files changed');return;}
  const out=path.join(root,'docs','data','consistency');fs.mkdirSync(out,{recursive:true});
  const lock=path.join(out,'.consistency.lock');let handle;
  try{handle=fs.openSync(lock,'wx');}catch{throw new Error('Consistency collector lock exists; another local run may be active');}
  try{
    const snapshot=await new Collector(root,cfg).run();
    console.log(JSON.stringify({mode:snapshot.mode,health:snapshot.health,summary:snapshot.summary,errors:snapshot.errors,warnings:snapshot.warnings}));
    if(snapshot.errors.length||!snapshot.summary.relationshipsChecked)process.exitCode=1;
  }finally{fs.closeSync(handle);fs.unlinkSync(lock);}
}
if(require.main===module)main().catch(e=>{
  console.error(e.stack||e);
  try{atomic(path.join(__dirname,'..','docs','data','consistency','status.json'),{generatedAt:new Date().toISOString(),mode:'OBSERVE_ONLY',health:'FAILED',errors:[String(e.message||e)]});}catch{}
  process.exitCode=1;
});
module.exports={main};
