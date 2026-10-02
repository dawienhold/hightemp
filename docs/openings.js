'use strict';
(() => {
const $=id=>document.getElementById(id),zones={KNYC:'America/New_York',KMIA:'America/New_York',KMDW:'America/Chicago',KLAX:'America/Los_Angeles',KSFO:'America/Los_Angeles'};
const colors=['#287bc1','#e28b2d','#9c6fc4','#2f9e8a','#d06580','#94a332','#a87550','#647cd0'];
let snap=null,event=null,report=null,visible=new Set(),request=0;
const esc=s=>String(s??'').replace(/[&<>"']/g,x=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[x]));
function time(iso,station,full=false){if(!iso||!Number.isFinite(Date.parse(iso)))return '—';return new Date(iso).toLocaleString('en-US',{timeZone:zones[station],...(full?{month:'short',day:'numeric'}:{}),hour:'numeric',minute:'2-digit',timeZoneName:'short'});}
function cents(u){return Number.isFinite(u)?(u/10000).toFixed(u%10000?1:0)+'¢':'—';}
function delta(a,b){if(!Number.isFinite(a)||!Number.isFinite(b))return '—';const d=(a-b)/10000;return `<span class="${d>0?'up':d<0?'down':''}">${d>0?'+':''}${d.toFixed(1)}¢</span>`;}
function value(q){return q?.usable&&Number.isFinite(q[$('price').value])?q[$('price').value]:null;}
async function json(file){const r=await fetch(file+'?t='+Date.now(),{cache:'no-store'});if(!r.ok)throw new Error('Could not load '+file+' (HTTP '+r.status+')');return r.json();}
function fact(label,text){return `<div class="fact"><span>${esc(label)}</span><b>${esc(text)}</b></div>`;}
function option(value,label){const el=document.createElement('option');el.value=value;el.textContent=label;return el;}
function displayStatus(s){return {LISTED:'Tomorrow listed',NOT_YET_OBSERVED:'Awaiting tomorrow',DISCOVERY_INCOMPLETE:'Check incomplete'}[s]||s;}
function renderTiles(){
 $('stations').innerHTML=(snap.waiting||[]).map(s=>{const e=snap.events.find(e=>e.station===s.station&&e.date===s.date);return `<div class="tile"><div class="station">${esc(s.station)}</div><div class="status">${esc(displayStatus(s.status))}</div><div class="muted">${esc(s.date)}</div><div class="muted">${e?'First seen '+esc(time(e.firstSeenAt,s.station,true)):'Last confirmed absent '+esc(time(s.lastAbsentAt,s.station,true))}</div></div>`;}).join('');
}
function chooseDates(){
 const old=$('date').value,rows=snap.events.filter(e=>e.station===$('station').value);
 $('date').replaceChildren(...[...new Set(rows.map(e=>e.date))].sort().reverse().map(d=>option(d,d)));
 if(rows.some(e=>e.date===old))$('date').value=old;
}
async function loadEvent(){
 const n=++request;event=null;$('detail').hidden=true;$('empty').hidden=false;$('empty').textContent='Loading price history…';
 const summary=snap.events.find(e=>e.station===$('station').value&&e.date===$('date').value);
 if(!summary){$('empty').textContent='No next-day listing has been recorded for this station yet.';return;}
 try {const e=await json('data/openings/'+summary.file);if(n!==request)return;event=e;event.summary=summary;visible=new Set(Object.keys(e.markets));$('empty').hidden=true;$('detail').hidden=false;renderEvent();}
 catch(e){if(n!==request)return;$('empty').textContent=e.message;}
}
function marketRows(){return Object.values(event.markets).sort((a,b)=>(a.band.low??-Infinity)-(b.band.low??-Infinity));}
function quoteCheckpoint(m,key){return event.summary.markets.find(r=>r.slug===m.slug)?.checkpoints?.[key];}
function cpCell(m,key,change=false){
 const cp=quoteCheckpoint(m,key);if(!cp||cp.status!=='RECORDED')return `<span class="muted">${esc(cp?.status==='PENDING'?'pending':cp?.status==='MISSING'?'missing':cp?.status==='AWAITING_SAMPLE'?'awaiting':'—')}</span>`;
 const first=m.quotes.find(q=>q.usable),v=value(cp.quote);
 return `<span tabindex="0" title="${esc(time(cp.at,event.station,true))}; ${cp.delayMinutes} min after target">${change?delta(v,value(first)):cents(v)}<small>${esc(time(cp.at,event.station))}</small></span>`;
}
function renderEvent(){
 if(!event)return;
 $('eventtitle').textContent=event.station+' · '+event.date;$('marketlink').href=event.url;
 const phase=event.summary.phase;
 $('facts').innerHTML=fact('First listing observed',time(event.firstSeenAt,event.station,true))+fact('Last confirmed absent',time(event.lastAbsentAt,event.station,true))+fact('First usable quote',time(event.firstQuoteAt,event.station,true))+fact('Tracking',phase==='COMPLETE'?'Morning collection complete':phase==='TODAY'?'Today · through 10 AM local':'Tomorrow')+fact('Opening coverage',event.capture==='BRACKETED'?'Observed absence → listing':'Initial baseline / unbracketed');
 $('legend').replaceChildren(...marketRows().map((m,i)=>{const l=document.createElement('label'),c=document.createElement('input'),dot=document.createElement('i');c.type='checkbox';c.checked=visible.has(m.slug);dot.style.background=colors[i%colors.length];l.append(c,dot,document.createTextNode(m.label.replace(/ F$/,'°F')));c.addEventListener('change',()=>{if(c.checked)visible.add(m.slug);else visible.delete(m.slug);renderChart();});return l;}));
 renderTables();renderChart();renderQuality();renderResearch();
}
function renderResearch(){
 const point=p=>p?cents(p.value)+'<small>'+esc(time(p.at,event.station,true))+(p.tiedObservations>1?' · '+esc(p.tiedObservations)+' ties; last '+esc(time(p.lastAt,event.station)):'')+'</small>':'—';
 $('research-bands').innerHTML=marketRows().map(m=>{const r=event.summary.markets.find(x=>x.slug===m.slug)?.research;
   if(!r)return '<tr><td>'+esc(m.label)+'</td><td colspan="6">Awaiting research snapshot.</td></tr>';
   return `<tr><td>${esc(m.label)}</td><td>${point(r.firstAsk)}</td><td>${point(r.minimumAsk)}</td><td>${point(r.maximumBid)}</td><td>${point(r.maximumBidAfterFirstAsk)}</td><td>${r.firstForecastRank!=null?'Rank '+esc(r.firstForecastRank)+' · '+(r.firstForecastProbability*100).toFixed(1)+'%':'Not saved'}<small>${esc(time(r.firstForecastAt,event.station,true))} · ${r.hasOpeningForecast?'opening coverage':'late or unavailable opening forecast'}</small></td><td>${esc(r.fullDepthObservations)} / ${esc(r.forecastObservations)}<small>Largest collection gap ${r.maxGapMinutes!=null?r.maxGapMinutes.toFixed(1)+' min':'—'}</small></td></tr>`;
 }).join('');
 const s=report?.stations?.find(s=>s.station===event.station);
 if(!s){$('station-timing').textContent='Timing report will populate after an upgraded collection run.';return;}
 $('station-timing').innerHTML='<p>'+esc(s.eventsRecorded)+' event days archived; '+esc(s.completedEventDays)+' completed; '+esc(s.openingForecastEventDays)+' completed with a leading band selected from an opening forecast. '+(s.status==='ACCUMULATING'?'Still accumulating data; no dependable best buying or selling time established.':'Descriptive averages are available; validate trading rules on later days before drawing conclusions.')+'</p>'+
 '<p>Each event day receives equal weight. Forecast leaders are fixed using the first saved forecast within 20 minutes of a bracketed first quote. Missing observations are excluded, never filled in.</p>'+
 '<div class="tablewrap"><table><thead><tr><th>Time after first quote</th><th>Event days</th><th>Average YES buy ask</th></tr></thead><tbody>'+s.entryByElapsed.map(x=>'<tr><td>'+esc(x.label)+'</td><td>'+esc(x.eventDays)+'</td><td>'+cents(x.meanU)+'</td></tr>').join('')+'</tbody></table></div>'+
 '<div class="tablewrap"><table><thead><tr><th>Station-local hour</th><th>Buy days</th><th>Average YES buy ask</th><th>Sell days</th><th>Average YES sell bid</th></tr></thead><tbody>'+s.buyByLocalHour.map((x,i)=>{const y=s.sellByLocalHour[i];return '<tr><td>'+esc(String(x.hour).padStart(2,'0'))+':00</td><td>'+esc(x.eventDays)+'</td><td>'+cents(x.meanU)+'</td><td>'+esc(y.eventDays)+'</td><td>'+cents(y.meanU)+'</td></tr>';}).join('')+'</tbody></table></div>';
}
function renderTables(){
 const ms=marketRows();
 $('bands').innerHTML=ms.map(m=>{const first=m.quotes.find(q=>q.usable),last=m.quotes.at(-1);return `<tr><td>${esc(m.label)}<small>${m.capture==='BRACKETED'?'opening window recorded':'initial baseline'}</small></td><td>${esc(time(m.firstQuoteAt,event.station,true))}</td><td>${cents(value(first))}</td>${[5,15,30,60].map(n=>'<td>'+cpCell(m,'plus'+n,true)+'</td>').join('')}<td>${cents(value(last))}<small>${esc(time(last?.at,event.station))}</small></td><td>${delta(value(last),value(first))}</td><td>${cents(last?.yesBid)} / ${cents(last?.yesAsk)}</td><td>${cents(last?.noBid)} / ${cents(last?.noAsk)}</td><td>${cents(last?.spread)}</td></tr>`;}).join('');
 $('overnight').innerHTML=ms.map(m=>{const q=m.quotes.at(-1);return `<tr><td>${esc(m.label)}</td>${[0,7,10].map(h=>'<td>'+cpCell(m,'local'+h)+'</td>').join('')}<td>${q?.yesBidQty??'—'}</td><td>${q?.yesAskQty??'—'}</td><td>${q?.usable?'Observed book':esc(q?.issues?.join(', ')||'No quote')}<small>Source updated ${esc(time(q?.asOf,event.station,true))}</small></td></tr>`;}).join('');
}
function renderChart(){
 if(!event)return;
 const rows=marketRows().filter(m=>visible.has(m.slug));
 let lo=-Infinity,hi=Infinity;
 const anchor=Date.parse(event.firstQuoteAt||event.firstSeenAt);
 if($('window').value==='hour'){lo=anchor;hi=lo+3600000;}
 if($('window').value==='prior')hi=Date.parse(event.summary.markets[0]?.research?.contractMidnightAt||event.summary.markets[0]?.checkpoints?.local0?.targetAt||'')-1;
 if($('window').value==='overnight'){
   const cp=event.summary.markets[0]?.checkpoints?.local0;lo=cp?.targetAt?Date.parse(cp.targetAt)-4*3600000:anchor;
 }
 const series=rows.map(m=>({m,i:marketRows().findIndex(x=>x.slug===m.slug),qs:m.quotes.filter(q=>Date.parse(q.at)>=lo&&Date.parse(q.at)<=hi)}));
 const times=series.flatMap(s=>s.qs.filter(q=>value(q)!=null).map(q=>Date.parse(q.at)));
 if(!times.length){$('chart').innerHTML='<div class="empty">No usable quotes in this view yet.</div>';$('chartnote').textContent='';return;}
 let xmin=Math.min(...times),xmax=Math.max(...times);if(xmax===xmin){xmin-=150000;xmax+=150000;}
 const W=1000,H=300,L=44,R=18,T=18,B=38,x=t=>L+(t-xmin)/(xmax-xmin)*(W-L-R),y=v=>H-B-v/1000000*(H-T-B);
 const out=[`<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc($('price').selectedOptions[0].textContent)} price history">`];
 for(const p of [0,25,50,75,100]){const yy=y(p*10000);out.push(`<line class="grid" x1="${L}" x2="${W-R}" y1="${yy}" y2="${yy}"/><text x="${L-8}" y="${yy+4}" text-anchor="end">${p}%</text>`);}
 for(let i=0;i<5;i++){const t=xmin+(xmax-xmin)*i/4,xx=x(t);out.push(`<text x="${xx}" y="${H-12}" text-anchor="${i===0?'start':i===4?'end':'middle'}">${esc(time(new Date(t).toISOString(),event.station))}</text>`);}
 const midnight=Date.parse(event.summary.markets[0]?.checkpoints?.local0?.targetAt||'');if(midnight>xmin&&midnight<xmax)out.push(`<line class="midnight" x1="${x(midnight)}" x2="${x(midnight)}" y1="${T}" y2="${H-B}"/><text x="${x(midnight)+5}" y="${T+12}">Today begins</text>`);
 for(const s of series){let segment=[],prev=null;
   const flush=()=>{if(segment.length>1)out.push(`<polyline fill="none" stroke="${colors[s.i%colors.length]}" stroke-width="2.3" points="${segment.join(' ')}"/>`);segment=[];};
   for(const q of s.qs){const v=value(q),t=Date.parse(q.at);if(v==null){flush();prev=null;continue;}if(prev&&t-prev>25*60000)flush();segment.push(`${x(t)},${y(v)}`);out.push(`<circle cx="${x(t)}" cy="${y(v)}" r="3" fill="${colors[s.i%colors.length]}"><title>${esc(s.m.label)} · ${cents(v)} · ${esc(time(q.at,event.station,true))}</title></circle>`);prev=t;}flush();
 }
 out.push('</svg>');$('chart').innerHTML=out.join('');$('chartnote').textContent='Dots are actual observations. Lines break for unusable quotes or collection gaps over 25 minutes. Midpoints require both sides of the book.';
}
function renderQuality(){
 const quoteCount=marketRows().reduce((n,m)=>n+m.quotes.length,0),failed=marketRows().reduce((n,m)=>n+m.quotes.filter(q=>!q.usable).length,0);
 $('quality').innerHTML='<p>'+esc(quoteCount)+' band observations · '+esc(failed)+' unusable/missing observations. Provider creation: '+esc(time(event.providerCreatedAt,event.station,true))+'. Provider creation is separate from public listing and quote availability.</p>'+
 '<div class="tablewrap"><table><thead><tr><th>Band</th><th>First listed</th><th>Absent before</th><th>Provider created</th><th>Provider open price / time</th><th>Rules</th></tr></thead><tbody>'+marketRows().map(m=>{const last=m.quotes.at(-1);return `<tr><td>${esc(m.label)}</td><td>${esc(time(m.firstSeenAt,event.station,true))}</td><td>${esc(time(m.lastAbsentAt,event.station,true))}</td><td>${esc(time(m.providerCreatedAt,event.station,true))}</td><td>${cents(last?.providerOpen)}<small>${esc(time(last?.providerOpenAt,event.station,true))}</small></td><td>${m.rulesChanged?'Changed; collection paused':m.missingFromLatestDetail?'Missing from latest listing':'Verified station / date / band'}</td></tr>`;}).join('')+'</tbody></table></div>'+
 (event.rejected?.length?'<p>Unmapped bands: '+esc(event.rejected.map(x=>x.slug+': '+x.issues.join(', ')).join('; '))+'</p>':'');
}
function exportCSV(){
 if(!event)return;const keys=['station','date','event','market','band','capture','firstSeenAt','lastAbsentAt','firstQuoteAt','at','asOf','phase','usable','yesBid','yesAsk','noBid','noAsk','midpoint','spread','yesBidQty','yesAskQty','noBidQty','noAskQty','lastTrade','lastTradeAt','providerOpen','providerOpenAt','sourceAgeSeconds','sharesTraded','openInterest','notionalTraded','researchVersion','localDate','localHour','minutesSinceFirstQuote','minutesSinceFirstListing','minutesToContractMidnight','forecastStatus','forecastId','forecastAt','forecastAgeMinutes','modelProbability','modelRank','forecastModels','forecastBuckets','forecastModelVersion','feeAssumption','minimumTradeQty','orderPriceMinTickSize','providerFeeCoefficient','depth','hypotheticalFills','issues'];
 const csvCell=x=>'"'+String(x??'').replace(/"/g,'""')+'"',rows=[keys.join(',')];
 for(const m of marketRows())for(const q of m.quotes){const f=event.forecasts?.[q.forecastId],r={station:event.station,date:event.date,event:event.slug,market:m.slug,band:m.label,capture:m.capture,firstSeenAt:m.firstSeenAt,lastAbsentAt:m.lastAbsentAt,firstQuoteAt:m.firstQuoteAt,minimumTradeQty:m.minimumTradeQty,orderPriceMinTickSize:m.orderPriceMinTickSize,providerFeeCoefficient:m.providerFeeCoefficient,...q,...q.timing,forecastAt:f?.ranAt,forecastModels:f?.models,forecastBuckets:f?.buckets,forecastModelVersion:f?.modelVersion,feeAssumption:event.feeAssumptions?.[q.feeAssumptionId],issues:(q.issues||[]).join('|')};rows.push(keys.map(k=>{const v=r[k];return csvCell(['yesBid','yesAsk','noBid','noAsk','midpoint','spread','lastTrade','providerOpen'].includes(k)&&Number.isFinite(v)?v/1000000:typeof v==='object'&&v!==null?JSON.stringify(v):v);}).join(','));}
 const url=URL.createObjectURL(new Blob([rows.join('\r\n')],{type:'text/csv;charset=utf-8'})),a=document.createElement('a');a.href=url;a.download=`market-openings-${event.station}-${event.date}.csv`;a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);
}
function exportJSON(){
 if(!event)return;const archive={...event};delete archive.summary;
 const url=URL.createObjectURL(new Blob([JSON.stringify(archive,null,2)],{type:'application/json'})),a=document.createElement('a');a.href=url;a.download=`market-research-${event.station}-${event.date}.json`;a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);
}
async function load(){
 try {snap=await json('data/openings/latest.json');if(snap.schemaVersion!==1||snap.venue!=='POLYMARKET_US')throw new Error('Unknown tracker snapshot');
 try{report=await json('data/openings/timing.json');}catch{report=null;}
 const old=$('station').value;$('station').replaceChildren(...Object.keys(zones).map(s=>option(s,s)));if(old)$('station').value=old;
 const generated=Date.parse(snap.generatedAt),age=(Date.now()-generated)/60000;let status=null;try{status=await json('data/openings/status.json');}catch{}
 $('stamp').textContent='Updated '+new Date(generated).toLocaleString()+' · Polymarket US';
 const msgs=[...(snap.errors||[]),...(snap.warnings||[])];if(age>20)msgs.unshift('Collection is '+Math.round(age)+' minutes old.');if(status?.health==='FAILED'&&Date.parse(status.generatedAt)>=generated)msgs.unshift(...status.errors);
 $('health').hidden=!msgs.length;$('health').className='notice warn';$('health').textContent=msgs.join(' · ');
 renderTiles();chooseDates();await loadEvent();}
 catch(e){$('stamp').textContent='Tracker snapshot unavailable';$('health').hidden=false;$('health').textContent=e.message+' — the page will populate after the first successful collector run.';$('empty').hidden=false;}
}
$('station').addEventListener('change',()=>{chooseDates();loadEvent();});$('date').addEventListener('change',loadEvent);$('window').addEventListener('change',renderChart);$('price').addEventListener('change',()=>{if(event){renderTables();renderChart();}});$('refresh').addEventListener('click',load);$('export').addEventListener('click',exportCSV);$('export-json').addEventListener('click',exportJSON);
load();setInterval(load,60000);
})();
