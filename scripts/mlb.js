#!/usr/bin/env node
'use strict';
const path=require('node:path');
const {MLBCollector,atomic}=require('./mlb/collector');
const root=path.join(__dirname,'..');
async function main(){
 if(process.argv.length>2)throw Error('This script accepts no command-line arguments');
 const snap=await new MLBCollector(root).run();
 console.log(JSON.stringify({at:snap.generatedAt,games:snap.games.length,errors:snap.errors,warnings:snap.warnings}));
 // Individual forecast gaps are visible but do not erase otherwise usable game cards.
}
if(require.main===module)main().catch(e=>{
 console.error(e.stack||e);
 atomic(path.join(root,'docs','data','mlb','status.json'),{lastRunAt:new Date().toISOString(),ok:false,errors:[String(e.message||e)],retainedPreviousSnapshot:true});
 process.exitCode=1;
});
module.exports={main};
