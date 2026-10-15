'use strict';
(() => {
  const $=id=>document.getElementById(id),node=(tag,cls,text)=>{const e=document.createElement(tag);if(cls)e.className=cls;if(text!=null)e.textContent=text;return e;};
  let snapshot=null,selected='today';
  const clock=(iso,tz)=>new Date(iso).toLocaleString('en-US',{timeZone:tz,month:'short',day:'numeric',hour:'numeric',minute:'2-digit',timeZoneName:'short'});
  function card(s) {
    const box=node('article','card'),tz=s.station==='KMDW'?'America/Chicago':'America/New_York';
    const head=node('div','cardhead');head.append(node('h2','',s.station+' · '+(s.name||'')),node('span','tag','Daily low'));box.append(head,node('p','muted',s.site||''));
    const d=s.low?.[selected];
    if(s.error||s.low?.error||!d){box.append(node('p','warn','Low forecast unavailable: '+(s.low?.error||s.error||'waiting for a successful forecast pass')));return box;}
    box.append(node('p','muted',d.date+' · climate date'));
    const point=node('div','point',d.point+'°');point.append(node('span','','F'));box.append(point,node('p','muted','Most likely whole-degree low'),node('p','interval','80% estimated range: '+d.i80[0]+'–'+d.i80[1]+'°F'));
    const facts=node('dl','facts');
    const fact=(label,value)=>{const col=node('div');col.append(node('dt','',label),node('dd','',value));facts.append(col);};
    const o=d.observation;
    fact('Lowest station evidence',o?(o.precise?o.f.toFixed(1)+'°F':o.band[0].toFixed(1)+'–'+o.band[1].toFixed(1)+'°F'):'No observations yet');
    fact('Remaining model minimum',d.remainingMin.toFixed(1)+'°F');
    fact('Day closes',clock(d.window.end,tz));fact('Models · low calibration dates',d.models.length+' · '+s.low.calibration.days);
    box.append(facts);
    if(o)box.append(node('p','muted',o.source+' · '+clock(o.at,tz)));
    if(d.prelim)box.append(node('p','muted','Preliminary CLI low: '+d.prelim.min+'°F; colder readings remain possible.'));
    const bars=node('div','bars');bars.append(node('p','muted','Individual degree probabilities'));
    const values=d.buckets.filter(b=>b.p>=.015),max=Math.max(...values.map(b=>b.p),.01);
    for(const b of values){const row=node('div','barrow'),track=node('div','track'),fill=node('div','fill');fill.style.width=(100*b.p/max)+'%';track.append(fill);row.append(node('span','',b.f+'°F'),track,node('span','',Math.round(b.p*100)+'%'));bars.append(row);}
    box.append(bars,node('p','muted','Provisional probabilities · '+s.low.modelVersion));
    if(s.stale||Date.now()-Date.parse(s.low.ranAt)>40*60000)box.append(node('p','warn','Stored forecast is overdue. Last successful low forecast: '+clock(s.low.ranAt,tz)));
    return box;
  }
  function render(){if(!snapshot)return;$('cards').replaceChildren(...['KNYC','KMDW'].map(id=>card(snapshot.stations.find(s=>s.station===id)||{station:id})));}
  for(const id of ['today','tomorrow'])$(id).addEventListener('click',()=>{selected=id;for(const n of ['today','tomorrow'])$(n).setAttribute('aria-pressed',String(n===id));render();});
  async function refresh(){
    try{const r=await fetch('data/latest.json?t='+Date.now(),{cache:'no-store'});if(!r.ok)throw Error('HTTP '+r.status);snapshot=await r.json();if(!Array.isArray(snapshot.stations))throw Error('Invalid forecast snapshot');$('status').textContent='Latest pass: '+new Date(snapshot.ranAt).toLocaleString();$('error').hidden=true;render();}
    catch(e){$('error').textContent='Could not refresh forecasts: '+e.message;$('error').hidden=false;}
    try{const r=await fetch('data/low/performance.json?t='+Date.now(),{cache:'no-store'});if(!r.ok)return;const p=await r.json();if(!p.rows?.length)return;
      $('scoreNote').textContent=p.method+' Fewer than 20 distinct dates is a limited sample.';
      const table=node('table'),thead=node('thead'),head=node('tr');for(const t of ['Station','Checkpoint','Days','MAE','Bias','80% coverage'])head.append(node('th','',t));thead.append(head);table.append(thead);const body=node('tbody');
      for(const r of p.rows){const row=node('tr');for(const v of [r.station,r.checkpoint,r.days,r.mae+'°F',(r.bias>0?'+':'')+r.bias+'°F',Math.round(r.cover80*100)+'%'])row.append(node('td','',v));body.append(row);}table.append(body);$('scores').replaceChildren(table);
    }catch{/* Scores appear only after the first successful recording pass. */}
  }
  refresh();setInterval(refresh,60000);
})();
