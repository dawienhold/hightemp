'use strict';
(() => {
  const $=id=>document.getElementById(id);
  const el=(tag,cls,txt)=>{const x=document.createElement(tag);if(cls)x.className=cls;if(txt!=null)x.textContent=txt;return x;};
  const money=u=>u==null?'--':new Intl.NumberFormat('en-US',{style:'currency',currency:'USD',maximumFractionDigits:2}).format(u/1e6);
  const pct=x=>x==null?'--':(x*100).toFixed(2)+'%';
  const time=x=>!x||!Number.isFinite(Date.parse(x))?'--':new Date(x).toLocaleString('en-US',{month:'short',day:'numeric',hour:'numeric',minute:'2-digit',second:'2-digit',timeZoneName:'short'});
  const readable=x=>String(x||'').toLowerCase().replace(/_/g,' ');
  const names={IMPLICATION_OR_EQUIVALENCE:'Nested threshold / equivalent outcome',EXCLUSIVE_NO_PAIR:'Non-overlapping bands: NO + NO',COVERING_YES_PAIR:'Covering pair: YES + YES',ALL_YES_COVER:'YES basket covering all temperatures',MULTI_NO_PAYOFF_FLOOR:'Multi-NO conditional payout floor'};
  const states={TWO_SNAPSHOT_CANDIDATE:'Survived two-snapshot stress check',FIRST_SNAPSHOT_ONLY:'First snapshot only - not confirmed',DID_NOT_SURVIVE_STRESS:'Did not survive stress assumptions',FIRST_EDGE_DISAPPEARED:'First price lead disappeared or was blocked',NO_NET_EDGE:'No qualifying net edge',BLOCKED:'Check blocked'};
  function message(parent,txt,cls='small muted'){parent.appendChild(el('p',cls,txt));}
  function link(text,url){const a=el('a','',text);try{const u=new URL(url,location.href);if(u.origin===location.origin||u.protocol==='https:'&&u.hostname==='polymarket.us'){a.href=u.href;if(u.origin!==location.origin){a.target='_blank';a.rel='noopener noreferrer';}}}catch{}return a;}
  function figure(label,value){const box=el('div','figure');box.append(el('span','label',label),el('span','value',value));return box;}
  function table(headers,rows){const wrap=el('div','tablewrap'),t=el('table');const head=el('thead'),tr=el('tr');for(const h of headers)tr.appendChild(el('th','',h));head.appendChild(tr);t.appendChild(head);const body=el('tbody');for(const values of rows){const r=el('tr');for(const v of values)r.appendChild(el('td','',v));body.appendChild(r);}t.appendChild(body);wrap.appendChild(t);return wrap;}
  function card(r,data){
    const card=el('article','candidate'),head=el('div','candidate-head'),title=el('div');
    title.append(el('h3','',`${r.station} | ${r.date} | ${names[r.type]||readable(r.type)}`),el('p','small muted',`${r.metric||'high'} temperature - Polymarket US`));
    head.append(title,el('span','badge '+(r.status==='TWO_SNAPSHOT_CANDIDATE'?'safe':''),states[r.status]||readable(r.status)));card.appendChild(head);
    const sized=r.stress||r.displayed||r.firstSnapshotDisplayed;
    if(sized){const figs=el('div','figures');figs.append(figure('Equal-size baskets',String(sized.bundles)),figure('Combined cost incl. fee estimate',money(sized.costU)),figure('Minimum numeric payout',money(sized.minimumPayoutU)),figure('Conditional minimum surplus',money(sized.minimumSurplusU)));card.appendChild(figs);
      message(card,`${pct(sized.minimumReturn)} conditional return on modeled basket cost; not annualized, executed, or realized.`);
      if(r.status==='FIRST_EDGE_DISAPPEARED')message(card,'The amounts above are from the EARLIER observation. They are not currently available prices.','small warn');
      card.appendChild(table(['Position / band','Equivalent book action','Average assumed cost per contract','Equal contracts','Fee upper estimate'],sized.legs.map(l=>[`${l.side} ${l.label}`,l.side==='YES'?'Buy at YES offers':'Sell YES into bids (NO exposure)',money(l.notionalU/sized.bundles),String(sized.bundles),money(l.feeU)])));
      message(card,`If only the most expensive leg filled and then lost, that leg's modeled cost is ${money(sized.largestSingleLegCostU)}. Full basket cost exposed if the shared-settlement premise fails: ${money(sized.costU)}.`,'small warn');
    }
    if(r.reasons?.length)message(card,r.reasons.map(readable).join('; '),'small warn');
    if(r.confirmation)message(card,`First check ${time(r.confirmation.firstAt)}; later check ${time(r.confirmation.secondAt)}. This does not establish continuous availability between checks.`);
    const detail=el('details'),sum=el('summary','','Show every numeric outcome, source rules, and assumptions');detail.appendChild(sum);
    detail.appendChild(table(['Shared final temperature',...r.legs.map(l=>l.side+' '+l.label),'Payout per basket'],r.proof.outcomes.map(p=>[p.label,...p.legPayouts.map(money),money(p.payoutU)])));
    message(detail,r.proof.scope,'small warn');
    for(const leg of r.legs){const m=data.markets.find(x=>x.slug===leg.slug);if(!m)continue;
      detail.appendChild(link(leg.side+' '+leg.label+' - exchange event',m.url));message(detail,leg.slug,'small mono');message(detail,m.description,'rules');
      if(/^[a-f0-9]{64}$/.test(m.rulesHash))detail.appendChild(link('Archived rule snapshot','data/consistency/rules/'+m.rulesHash+'.json'));
    }
    message(detail,'Different baskets may use the same orders. No balance is connected, no orders are submitted, and no profit is booked.');card.appendChild(detail);return card;
  }
  function render(d,runStatus){
    if(d.schemaVersion!==1||d.mode!=='OBSERVE_ONLY'||!d.summary||!Array.isArray(d.markets))throw new Error('Unsupported consistency snapshot');
    $('content').hidden=false;$('empty').hidden=true;
    const age=(Date.now()-Date.parse(d.generatedAt))/60000;
    $('stamp').textContent=`Published ${time(d.generatedAt)} | ${d.version} | READ ONLY`;
    const bad=[];
    if(age>25)bad.push(`Published data is ${Math.floor(age)} minutes old. Do not treat its prices as current.`);
    if(age < -2)bad.push('Publication time is in the future relative to this device. Check the clocks.');
    if(runStatus&&Date.parse(runStatus.generatedAt)>Date.parse(d.generatedAt)&&runStatus.health==='FAILED')bad.push('A newer run failed; the cards below are from an older run. '+(runStatus.errors||[]).join('; '));
    $('failure').hidden=!bad.length;$('failure').textContent=bad.join(' ');
    const s=d.summary;$('tiles').replaceChildren();
    for(const [label,val,note] of [['Relationships checked',s.relationshipsChecked,'rule-compatible combinations'],['Latest-scan price leads',s.currentDisplayedCandidateBaskets,'recorded prices, not live quotes'],['Rechecked candidates',s.twoSnapshotCandidateBaskets,'all legs passed the stress scenario'],['Events inspected',s.eventsInspected,`${s.validBooks} usable books / ${s.booksReceived} received`]]){
      const tile=el('div','tile');tile.append(el('span','',label),el('b','',String(val??0)),el('span','',note));$('tiles').appendChild(tile);
    }
    $('health').textContent=readable(d.health);$('health').className='status '+(d.health==='OBSERVATIONS_AVAILABLE'?'good':'warn');
    $('coverage').textContent=`${s.verifiedMarkets}/${s.marketsInspected} market rules accepted. ${d.discovery?.searchCoverageComplete?'Search ended before its configured caps.':'Discovery coverage is incomplete or unverified.'} Last run took ${Math.round(d.durationSeconds)} seconds. Publication gaps are not trading latency.`;
    $('warnings').replaceChildren();for(const w of [...(d.warnings||[]),...(d.errors||[])])message($('warnings'),w,'small warn');
    $('diagnostics').replaceChildren();
    const chips=el('div','chips');for(const [k,v] of Object.entries(d.blockers||{}))chips.appendChild(el('span','chip',`${readable(k)}: ${v}`));$('diagnostics').appendChild(chips);
    message($('diagnostics'),JSON.stringify(d.discovery,null,2),'rules');
    $('candidates').replaceChildren();
    if(!d.candidates?.length)$('candidates').appendChild(el('div','empty','No qualifying price leads were recorded in this scan. This can be a correct result. Check missing depth, stale books, fees, rule mismatches, and coverage below.'));
    else for(const r of d.candidates)$('candidates').appendChild(card(r,d));
    $('candidateLimit').textContent=d.candidatesOmitted?`${d.candidatesOmitted} additional alternative baskets are omitted from this view; see the archive.`:'';
    $('families').replaceChildren();
    for(const g of d.groups||[]){const tr=el('tr');const first=el('td');first.append(link(g.title||g.eventSlug,'https://polymarket.us/event/'+g.eventSlug),el('p','small muted',g.eventSlug));
      const meta=el('td','',`${g.verifiedMarkets??0}/${g.eventMarkets??0} rules; ${g.validBooks??0}/${g.booksReceived??0} books`);
      if(g.rejected?.length){const de=el('details');de.appendChild(el('summary','',`${g.rejected.length} rules need review`));for(const m of g.rejected)message(de,`${m.slug}: ${[...m.issues,...(m.rulesChanged?['rules changed']:[])].map(readable).join('; ')}`,'small warn');meta.appendChild(de);}
      const cover=el('td');if(g.error)message(cover,g.error,'small bad');for(const f of g.groups||[]){message(cover,`${f.station} ${f.date}: ${f.completeNumericPartition?'complete non-overlapping numeric partition':'not a complete numeric partition'}`);if(f.gaps?.length)message(cover,'Gaps: '+f.gaps.join(', '));if(f.overlaps?.length)message(cover,'Overlaps: '+f.overlaps.join(', '));}
      tr.append(first,meta,cover,el('td','',String(g.relationships??0)));$('families').appendChild(tr);
    }
    $('near').replaceChildren();const ns=d.nearMisses||[];
    if(!ns.length)$('near').appendChild(el('div','empty','No priceable near misses to display. Empty or rejected books cannot supply a cost estimate.'));
    else $('near').appendChild(table(['Station / date','Combination','Cost incl. fee estimate','Minimum numeric payout','Conditional gap'],ns.map(r=>[`${r.station} ${r.date}`,r.legs.map(l=>l.side+' '+l.label).join(' + '),money(r.indicative.costU),money(r.indicative.minimumPayoutU),money(r.indicative.minimumSurplusU)])));
    $('history').replaceChildren();for(const e of d.recentEpisodes||[]){const tr=el('tr');tr.append(el('td','',`${e.station} ${e.date}`),el('td','',e.legs.map(l=>l.side+' '+l.label).join(' + ')),el('td','',time(e.firstSeenAt)+' / '+time(e.lastSeenAt)),el('td','',`${e.observations} / ${e.twoSnapshotObservations}`),el('td','',states[e.lastStatus]||readable(e.lastStatus)));$('history').appendChild(tr);}
    if(!d.recentEpisodes?.length){const tr=el('tr'),td=el('td','muted','No qualifying patterns recorded yet.');td.colSpan=5;tr.appendChild(td);$('history').appendChild(tr);}
    const c=d.settings;$('settings').textContent=`Experiment settings: at most ${money(Number(c.maxHypotheticalBasketCost)*1e6)} modeled cost per basket; ${c.stressDepthPercent}% shared depth; ${money(Number(c.adversePricePerLeg)*1e6)} adverse buffer per leg; minimum ${money(Number(c.minNetSurplusPerBundle)*1e6)} surplus per basket unit and ${pct(c.minNetReturn)} conditional return. Fees: taker coefficient ${c.feeCoefficient}, rounded UP per leg; reviewed ${c.feeReviewedOn}, review required after ${c.feeReviewAfterDays} days. These are observation settings, not investment instructions.`;
  }
  function sources(file){const urls=[new URL('data/consistency/'+file,document.baseURI).href];const match=location.hostname.match(/^([a-z0-9-]+)\.github\.io$/i);const repo=location.pathname.split('/').filter(Boolean)[0];if(match&&repo)urls.push(`https://raw.githubusercontent.com/${match[1]}/${encodeURIComponent(repo)}/main/docs/data/consistency/${file}`);return urls;}
  async function getJSON(url){const r=await fetch(url+'?t='+Date.now(),{cache:'no-store',signal:AbortSignal.timeout(12000)});if(!r.ok)throw new Error('HTTP '+r.status);return r.json();}
  async function latest(file){const rs=await Promise.allSettled(sources(file).map(getJSON));return rs.filter(r=>r.status==='fulfilled').map(r=>r.value).sort((a,b)=>Date.parse(b.generatedAt)-Date.parse(a.generatedAt))[0]||null;}
  let busy=false;
  async function refresh(){if(busy)return;busy=true;$('refresh').disabled=true;try{const [d,status]=await Promise.all([latest('latest.json'),latest('status.json')]);if(!d){$('empty').hidden=false;$('content').hidden=true;$('stamp').textContent='No published snapshot available';if(status?.errors?.length){$('failure').hidden=false;$('failure').textContent=status.errors.join('; ');}return;}render(d,status);}catch(e){$('failure').hidden=false;$('failure').textContent='Could not read the current snapshot: '+e.message;}finally{busy=false;$('refresh').disabled=false;}}
  $('refresh').addEventListener('click',refresh);refresh();setInterval(()=>{if(!document.hidden)refresh();},60000);
  // Testable renderer, no account or trading functions exposed.
  window.ConsistencyUI={render};
})();
