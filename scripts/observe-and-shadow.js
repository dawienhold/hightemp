#!/usr/bin/env node
'use strict';
// Both workers share one GitHub concurrency group; each writes only its own directory.
// Weather collection never waits for slow financial requests.
const {spawn}=require('node:child_process');const path=require('node:path');
function worker(file){return new Promise(resolve=>{const p=spawn(process.execPath,[path.join(__dirname,file)],{stdio:'inherit',env:process.env});
 p.once('error',e=>{console.error(file+': '+e.message);resolve(1);});p.once('exit',(code,signal)=>resolve(signal?1:(code??1)));});}
async function main(){const results=await Promise.all([worker('observe.js'),worker('shadow.js')]);
 if(results.some(n=>n!==0)){console.error('One observer failed. Partial results remain saved; forecast-pass is independent.');process.exitCode=1;}}
if(require.main===module)main();
