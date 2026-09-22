#!/usr/bin/env node
'use strict';
// Read-only audit. Never alters paper positions or writes into docs/data.
// Usage: node tools/audit-shadow.js path/to/YYYY-MM-DD.jsonl[.gz] [report.json]
const fs=require('node:fs'),zlib=require('node:zlib'),crypto=require('node:crypto');
const C=require('../scripts/shadow/core');
function audit(contents){
 const rows=contents.split(/\r?\n/).filter(x=>x.trim()).map((x,i)=>{try{return {...JSON.parse(x),_line:i+1};}catch{throw Error('Invalid JSON at line '+(i+1));}});
 const kinds={},statuses={},meta=new Map(),book=new Map(),signals=[],cycles=[],invalid=new Map(),perMarket={};
 let observations=0,eliminated=0,eliminatedNoOffers=0,correctedEliminated=0,correctedNoOffers=0,correctedWithOffers=0;
 const correctedOfferExamples=[];const timestamps=[];const errors=[];const finalDates=new Set();
 const count=(o,k)=>o[k]=(o[k]||0)+1;
 for(const r of rows){
  count(kinds,r.kind);if(r.at)timestamps.push(r.at);
  if(r.kind==='MARKET_RULES')for(const m of r.markets||[]){meta.set(m.slug,m);if(!m.valid)invalid.set(m.slug,m);}
  if(r.kind==='BOOK')book.set(r.market,r);
  if(r.kind==='ELIMINATION_FIRST_OBSERVED')signals.push({line:r._line,market:r.market,firstSeenAt:r.firstSeenAt,firstNoAsk:r.firstNoAsk});
  if(r.kind==='CLI_FINAL')finalDates.add(r.station+'|'+r.date);
  if(r.kind==='CYCLE'){cycles.push(r);if(r.errors?.length)errors.push({line:r._line,at:r.at,errors:r.errors});}
  if(r.kind!=='MARKET_OBSERVATION')continue;
  observations++;count(statuses,r.status);
  const m=meta.get(r.market),b=book.get(r.market),band=m?.band;
  const pm=perMarket[r.market] ||= {station:r.station,date:r.date,observations:0,statusCounts:{},eliminatedChecks:0,withNoOffersWhenEliminated:0};
  pm.observations++;count(pm.statusCounts,r.status);
  if(m&&Number.isFinite(band?.high)&&r.floorF!=null&&r.floorF>band.high){
    eliminated++;pm.eliminatedChecks++;
    if(b?.noAsks?.length===0)eliminatedNoOffers++;else if(b?.noAsks?.length)pm.withNoOffersWhenEliminated++;
  }
  // This is a parser sensitivity audit of CAPTURED records, not a hindsight trade replay.
  const fixed=m?C.parseBand(m.rules):null;
  if(m&&!m.valid&&fixed?.high!=null&&r.floorF!=null&&r.floorF>fixed.high){
    correctedEliminated++;
    if(b?.noAsks?.length===0)correctedNoOffers++;
    else if(b?.noAsks?.length){correctedWithOffers++;if(correctedOfferExamples.length<10)correctedOfferExamples.push({line:r._line,at:r.at,market:r.market,noAsks:b.noAsks,quoteAsOf:b.asOf});}
  }
 }
 const gaps=cycles.map(r=>r.gapSeconds).filter(Number.isFinite).sort((a,b)=>a-b);
 const median=a=>!a.length?null:a.length%2?a[(a.length-1)/2]:(a[a.length/2-1]+a[a.length/2])/2;
 return {records:rows.length,firstRecordedAt:timestamps.sort()[0],lastRecordedAt:timestamps.at(-1),kinds,marketObservations:observations,statuses,
   cycles:cycles.length,cyclesWithErrors:errors.length,errorExamples:errors.slice(0,10),uniqueMappedMarkets:meta.size,invalidMappedMarkets:invalid.size,
   invalidRuleExamples:[...invalid.values()].slice(0,4).map(m=>({market:m.slug,rules:m.rules,issues:m.issues})),
   originallyParsedEliminatedChecks:eliminated,originallyParsedEliminatedChecksWithEmptyNoBook:eliminatedNoOffers,
   additionalEliminatedChecksRecognizedByUpdatedParser:correctedEliminated,additionalChecksWithEmptyNoBook:correctedNoOffers,
   additionalChecksWithNonemptyNoBook:correctedWithOffers,correctedOfferExamples,
   gapSeconds:{count:gaps.length,median:median(gaps),max:gaps.length?gaps.at(-1):null,over180:gaps.filter(x=>x>180).length,over300:gaps.filter(x=>x>300).length,over600:gaps.filter(x=>x>600).length},
   signals,perMarket,finalCliStationDates:[...finalDates].sort(),
   limitations:['One uploaded archive; not proof of continuous observation or a complete local day.',
    'A log decision is not an independent opportunity or a real fill. No hypothetical historical trades are inserted.',
    'Existing BOOK rows are already-normalized snapshots, not the complete raw HTTP responses. Parser correctness at HTTP level cannot be fully revalidated from this archive.',
    'No quotes can be reconstructed for omitted markets or sampling gaps. Updated parsing cannot retroactively recover missed observations.']};
}
if(require.main===module){
 const [input,output]=process.argv.slice(2);if(!input)throw Error('Provide JSONL or gzip input path');
 const data=fs.readFileSync(input),decoded=(data[0]===31&&data[1]===139?zlib.gunzipSync(data):data).toString('utf8');
 const report={input:require('node:path').basename(input),sha256:crypto.createHash('sha256').update(data).digest('hex'),...audit(decoded)};
 if(output)fs.writeFileSync(output,JSON.stringify(report,null,2)+'\n');else console.log(JSON.stringify(report,null,2));
}
module.exports={audit};
