/* Read-only observation panel. No exchange account or browser trading code. */
(() => {
 'use strict';
 const e=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
 const label=s=>({COLLECTING_VALIDATION:'Collecting validation data',VALIDATED_ADVISORY:'Validated advisory only',BASELINE_BETTER:'Baseline performed better',ABSTAIN:'Abstaining'}[s]||s||'unavailable');
 const n=(v,d=1)=>Number.isFinite(v)?v.toFixed(d):'--';
 const ago=iso=>{const t=Date.parse(iso),m=(Date.now()-t)/60000;return !Number.isFinite(m)?'unavailable':m<0?'future timestamp':m<1?'<1 minute':m<120?`${Math.round(m)} minutes`:`${(m/60).toFixed(1)} hours`;};
 let host=document.getElementById('input-status');
 if(!host){host=document.createElement('section');host.id='input-status';const anchor=document.getElementById('live')||document.getElementById('grid');if(anchor)anchor.before(host);else document.body.append(host);}
 const style=document.createElement('style');style.textContent=`
 #input-status{background:var(--surface,#162027);color:var(--ink,#e4edf3);border:1px solid var(--line,#2a3a45);border-radius:12px;padding:18px;margin:20px 0;font:14px/1.5 system-ui,sans-serif}
 #input-status h2{margin:0 0 8px;font-size:20px}#input-status h3{font-size:16px;margin:4px 0}
 #input-status .ins-muted{color:var(--mut,#9bb0bd)}#input-status .ins-warn{color:#df9b36}#input-status .ins-good{color:#19b9a5}
 #input-status .ins-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(280px,1fr));gap:12px}
 #input-status .ins-card{border:1px solid var(--line,#2a3a45);padding:12px;border-radius:8px;min-width:0}
 #input-status .ins-head{display:flex;flex-wrap:wrap;align-items:baseline;gap:10px;justify-content:space-between}
 #input-status p{margin:6px 0}#input-status a{color:var(--mod,#58c5e0)}#input-status details{margin-top:12px}
 #input-status table{border-collapse:collapse;width:100%;font-size:12px}#input-status th,#input-status td{text-align:left;padding:6px;border-bottom:1px solid var(--line,#2a3a45);vertical-align:top}
 #input-status .ins-scroll{overflow-x:auto}#input-status .ins-small{font-size:12px}#input-status .ins-errors{overflow-wrap:anywhere}
 #input-status button{border:1px solid #50646e;border-radius:6px;padding:5px 10px;background:transparent;color:inherit;cursor:pointer}
 @media(max-width:420px){#input-status{padding:10px}#input-status .ins-grid{grid-template-columns:1fr}}
 `;document.head.append(style);
 const link=r=>r?.sourceUrl&&/^https:\/\/(api\.weather\.gov|tgftp\.nws\.noaa\.gov|forecast\.weather\.gov|aviationweather\.gov)\//.test(r.sourceUrl)?`<a href="${e(r.sourceUrl)}" target="_blank" rel="noopener">source report</a>`:'';
 function station(s){const o=s.observed,p=s.neighbor||{},m=p.model||{},ev=s.evidence||{},v=ev.evidence;
  const rows=Object.entries(m.weights||{}).map(([id,x])=>`<tr><td>${e(id)}</td><td>${n(100*x.weight,0)}%</td><td>${n(x.slope,2)}</td><td>${x.n}</td></tr>`).join('');
  return `<article class="ins-card"><h3>${e(s.station)} <span class="ins-muted ins-small">${e(s.name)}</span></h3>
   <p>Latest measured: <b>${o?(o.precisionC===.1?n(o.f)+' F':n(o.f-.9)+' to '+n(o.f+.9)+' F (whole-C range)'):'unavailable'}</b><br><span class="ins-muted">${o?e(o.source)+'; '+ago(o.at)+' old; '+(o.precisionC===.1?'tenth-C report':'whole-C report'):'No usable report'}</span></p>
   <p>${v?`Published evidence floor: <b>${n(v.floorF,0)} F</b> (${e(v.kind)})`:'No qualifying climate/extrema floor yet'}${ev.conflict?'<br><b class="ins-warn">Conflicting reports: review required</b>':''}</p>
   <p class="ins-small ins-muted">Published evidence may be corrected; not exchange settlement. ${link(v)}</p>
   <p><b>Current-temperature research estimate: ${p.ok?n(p.candidateF)+' F':'abstaining'}</b><br><span class="${p.status==='VALIDATED_ADVISORY'?'ins-good':'ins-warn'}">${e(label(p.status))}</span></p>
   <p class="ins-small">${e(m.reason||p.reason||'Collecting observations')}</p>
   ${p.ok?`<p class="ins-small ins-muted">Preferred advisory: ${n(p.preferredF)} F. Anchor age ${n(p.anchorAgeMinutes,0)} min; ${p.inputs.length} paired neighbors. Estimate is not a measured high or a CLI probability.</p>`:''}
   <details><summary>Weights and held-out validation</summary><p class="ins-small">${s.trainingPairs||0} prospectively scored pairs. Horizon bucket means age of target anchor, not future forecast lead. Validation is by later days, not random rows.</p>
   <p class="ins-small">${e(m.scope||'No trained weights yet')}; training ${m.trainSamples||0} samples / ${m.trainDays||0} days; validation ${m.validationSamples||0} samples / ${m.validationDays||0} days.</p>
   ${rows?`<div class="ins-scroll"><table><thead><tr><th>Neighbor</th><th>Weight</th><th>Slope</th><th>Train n</th></tr></thead><tbody>${rows}</tbody></table></div>`:'<p>Equal-change research baseline only until enough paired observations are available.</p>'}
   <p class="ins-small">Held-out MAE: weighted ${n(m.mae,2)} F; last-reading baseline ${n(m.persistenceMAE,2)} F; equal-change ${n(m.equalChangeMAE,2)} F.</p>
   <p class="ins-small">Historical validation 90th-percentile absolute error: ${n(m.empiricalAbsErrorP90F)} F. This is not a guaranteed prediction interval.</p></details>
   <details><summary>Timing, sources and DSM research</summary><p class="ins-small">Last reading first seen ${o?n(o.firstSeenDelaySeconds/60)+' min':'--'} after observation time. The delay includes report cadence, source processing and collection gaps.</p>
   <p class="ins-small">Last 24h first-seen delay: median ${n(s.latency?.firstSeenP50Seconds/60)} min, 90th percentile ${n(s.latency?.firstSeenP90Seconds/60)} min. Startup backfill can inflate this.</p>
   ${s.dsm?`<p class="ins-small">Research-only DSM: ${n(s.dsm.maxF,0)} F; issued ${e(s.dsm.issuedAt)}. ${link(s.dsm)} Not used for locks, paper entries or the forecast floor.</p>`:'<p class="ins-small">No current-date usable DSM. This does not block the other sources.</p>'}
   <div class="ins-errors">${(s.checks||[]).map(c=>`<p class="ins-small ${c.ok?'':'ins-warn'}">${e(c.source)}: ${c.ok?'checked '+ago(c.checkedAt)+' ago; '+c.records+' parsed records':e(c.error||'not available')}</p>`).join('')}</div></details></article>`;
 }
 function render(d){const stale=Date.now()-Date.parse(d.generatedAt)>10*60000;
  host.innerHTML=`<div class="ins-head"><h2>Data input health &amp; nearby estimates</h2><button id="input-refresh">Refresh</button></div>
   <p class="${stale?'ins-warn':'ins-muted'}">Observation snapshot ${ago(d.generatedAt)} old. ${stale?'STALE: do not treat this as live.':''} <a href="observations.html">Detailed view</a></p>
   <p class="ins-small">These observations refresh separately from the forecast model. Estimates and DSM research never trigger hard locks or paper entries. New data is published to GitHub at session end, with scheduling and deployment delays.</p>
   <p class="ins-small ins-muted">Last sampling gap ${n(d.sampling?.lastGapSeconds,0)} seconds; longest recorded ${n(d.sampling?.maxGapSeconds/60)} minutes. No promise of continuous coverage.</p>
   <div class="ins-grid">${d.stations.map(station).join('')}</div>
   <details><summary>All provider diagnostics</summary><div class="ins-errors">${Object.entries(d.health?.checks||{}).map(([k,c])=>`<p class="ins-small ${c.ok?'':'ins-warn'}">${e(k)}: ${c.ok?'OK, checked '+ago(c.checkedAt)+' ago':e(c.error||'unavailable')}</p>`).join('')}</div></details>`;
  document.getElementById('input-refresh').onclick=load;
 }
 let busy=false,last=null;
 async function load(){if(busy)return;busy=true;try{
  const endpoints=['data/observations/latest.json','https://raw.githubusercontent.com/dawienhold/hightemp/main/docs/data/observations/latest.json'];
  const result=await Promise.allSettled(endpoints.map(async url=>{const r=await fetch(url,{cache:'no-store',signal:AbortSignal.timeout(8000)});if(!r.ok)throw Error('HTTP '+r.status);const d=await r.json();
   if(d.schemaVersion!==1||!Array.isArray(d.stations)||!Number.isFinite(Date.parse(d.generatedAt))||Date.parse(d.generatedAt)>Date.now()+60000)throw Error('Invalid snapshot');return d;}));
  const docs=result.filter(x=>x.status==='fulfilled').map(x=>x.value).sort((a,b)=>Date.parse(b.generatedAt)-Date.parse(a.generatedAt));
  if(docs.length){last=docs[0];render(last);}else if(last){render(last);host.insertAdjacentHTML('afterbegin','<p class="ins-warn">Refresh failed; showing the last received snapshot.</p>');}
  else host.innerHTML='<h2>Data input health</h2><p>No observation snapshot yet. Run <b>Actions &gt; shadow-observer</b> after uploading all files. This does not stop the forecast dashboard.</p>';
 }finally{busy=false;}}
 load();setInterval(load,60000);
})();
