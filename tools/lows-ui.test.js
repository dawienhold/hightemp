'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
test('low page renders both stations, switches dates and exposes refresh failures',async()=>{
  class Element {
    constructor(tag){this.tag=tag;this.children=[];this.style={};this.attrs={};this.listeners={};this.hidden=false;}
    append(...xs){this.children.push(...xs);} replaceChildren(...xs){this.children=xs;}
    setAttribute(k,v){this.attrs[k]=v;}addEventListener(k,fn){this.listeners[k]=fn;}
  }
  const html=fs.readFileSync(path.join(__dirname,'../docs/lows.html'),'utf8'),ids={};
  for(const [,id] of html.matchAll(/id="([^"]+)"/g))ids[id]=new Element('div');
  const document={getElementById:id=>ids[id],createElement:tag=>new Element(tag)};
  const day=point=>({date:'2026-10-15',point,i80:[point-2,point+2],remainingMin:point,models:[{},{}],buckets:[{f:point,p:1}],window:{end:'2026-10-16T05:00Z'}});
  const snap={ranAt:new Date().toISOString(),stations:['KNYC','KMDW'].map(station=>({station,name:station,low:{today:day(50),tomorrow:day(45),ranAt:new Date().toISOString(),calibration:{days:8},modelVersion:'low-1.0.0'}}))};
  let callback,fail=false;
  vm.runInNewContext(fs.readFileSync(path.join(__dirname,'../docs/lows.js'),'utf8'),{document,Date,Intl,Number,Math,setInterval:fn=>{callback=fn;},fetch:async url=>{if(fail)throw Error('offline');return {ok:true,json:async()=>url.includes('performance')?{rows:[]}:snap};}});
  const flush=()=>new Promise(resolve=>setImmediate(resolve));await flush();
  const find=(e,cls)=>[...(e.className===cls?[e]:[]),...e.children.flatMap(c=>typeof c==='object'?find(c,cls):[])];
  assert.equal(ids.cards.children.length,2);assert.equal(find(ids.cards,'point')[0].textContent,'50°');
  ids.tomorrow.listeners.click();assert.equal(ids.tomorrow.attrs['aria-pressed'],'true');assert.equal(find(ids.cards,'point')[0].textContent,'45°');
  fail=true;await callback();await flush();assert.equal(ids.error.hidden,false);assert.match(ids.error.textContent,/offline/);assert.equal(ids.cards.children.length,2);
});
