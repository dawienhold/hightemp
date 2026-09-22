'use strict';
const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');
const C = require('./core.js');
const sleep = ms => new Promise(r => setTimeout(r,ms));
const MARKET = 'https://gateway.polymarket.us';
const NWS = 'https://api.weather.gov';
const AV = 'https://aviationweather.gov';
const READ_PATHS = {
  'gateway.polymarket.us': /^\/v1\/(?:search|markets|events\/slug\/[a-z0-9-]+|market\/slug\/[a-z0-9-]+|markets\/[a-z0-9-]+\/(?:book|settlement))$/,
  'api.weather.gov': /^\/(?:products\/types\/CLI\/locations\/[A-Z]{3}|products\/[a-zA-Z0-9-]+)$/,
  'aviationweather.gov': /^\/api\/data\/metar$/
};
function allowedURL(input) {
  const u = new URL(input);
  if(u.protocol!=='https:' || u.username || u.password || u.port || !READ_PATHS[u.hostname]?.test(u.pathname)) {
    throw new Error('Read-only network allowlist rejected URL');
  }
  return u;
}
function createClient(cfg, transport=global.fetch, clock=Date.now) {
  let tail=Promise.resolve(), previousStart=0;
  async function gate() {
    const ready=tail.then(async()=>{await sleep(Math.max(0,250-(clock()-previousStart))); previousStart=clock();});
    tail=ready.catch(()=>{}); await ready;
  }
  return async function read(input) {
    const u=allowedURL(input);
    for(let attempt=0;attempt<2;attempt++) {
      await gate();
      const startedAt=clock();
      try {
        // This is the ONLY financial/weather HTTP operation in the package.
        // There is no credential loader, signer, order endpoint, or non-GET path.
        const r=await transport(u.href,{method:'GET',redirect:'error',headers:{
          Accept:'application/geo+json,application/json',
          'User-Agent':'hightemp-shadow-paper-only (github.com/dawienhold/hightemp)',
          'Cache-Control':'no-cache'
        },signal:AbortSignal.timeout(cfg.maxRequestSeconds*1000)});
        if(r.status===429 || r.status>=500) {
          if(attempt===0) {
            const retry=Number(r.headers?.get('retry-after'));
            if(Number.isFinite(retry)&&retry>10) throw new Error('Rate limit: long Retry-After; stopped this request');
            await sleep(Math.max(1000,Number.isFinite(retry)?retry*1000:1000)); continue;
          }
        }
        if(!r.ok) throw new Error(`HTTP ${r.status} ${u.hostname}${u.pathname}`);
        const data=r.status===204?[]:await r.json();
        const receivedAt=clock();
        return {data,url:u.href,startedAt:C.iso(startedAt),receivedAt:C.iso(receivedAt),durationMs:receivedAt-startedAt};
      } catch(e) {
        // Do not retry schema/access failures or fetch an authenticated substitute.
        throw new Error(`${u.hostname}${u.pathname}: ${e.message}`);
      }
    }
    throw new Error('Read failed');
  };
}
function readJSON(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file,'utf8')); }
  catch(e) { if(e.code==='ENOENT') return fallback; throw new Error('Refusing to reset unreadable state: '+file+' ('+e.message+')'); }
}
function atomic(file, doc) {
  fs.mkdirSync(path.dirname(file),{recursive:true});
  const temp=file+'.tmp'; fs.writeFileSync(temp,JSON.stringify(doc,null,2)+'\n'); fs.renameSync(temp,file);
}
class Collector {
  constructor(root,cfg,{read,clock=Date.now}={}) {
    this.root=root; this.cfg=C.validateConfig(cfg); this.clock=clock;
    this.out=path.join(root,'docs','data','shadow');
    this.read=read || createClient(cfg);
    this.state=readJSON(path.join(this.out,'state.json'),{schemaVersion:1,mode:'PAPER_ONLY',evidence:{},signals:{},positions:{},previousBooks:{},ruleBaselines:{},sourceChecks:{},rawHashes:{}});
    if(this.state.schemaVersion!==1||this.state.mode!=='PAPER_ONLY') throw new Error('Unknown shadow state schema; refusing to overwrite');
    this.pendingLogs=[]; this.markets=[]; this.errors=[]; this.warnings=[];
    this.cliCache=this.state.cliCache || {};
    this.lastCliAttempt=0; this.lastDiscoveryAttempt=0;
    this.rawCycle=[];
  }
  log(kind,data={}) { this.pendingLogs.push({at:C.iso(this.clock()),kind,...data}); }
  raw(kind, data, key) {
    const h=C.hash(data);
    if(key && this.state.rawHashes[key]===h) return;
    if(key) this.state.rawHashes[key]=h;
    this.rawCycle.push({at:C.iso(this.clock()),kind,...data});
  }
  remember(e) {
    if(!e) return;
    const old=this.state.evidence[e.key];
    if(old?.issuedAt&&e.issuedAt&&Date.parse(old.issuedAt)>Date.parse(e.issuedAt)) return;
    if(!old || old.id!==e.id) {
      this.raw('WEATHER_EVIDENCE',e,e.key);
      this.log(old?'WEATHER_REVISION':'WEATHER_FIRST_OBSERVED',{station:e.station,date:e.date,id:e.id,key:e.key,
        kindOfEvidence:e.kind,floorF:e.floorF,sourceUrl:e.sourceUrl,issuedAt:e.issuedAt,observedAt:e.observedAt,previousId:old?.id||null});
    }
    this.state.evidence[e.key]={...e,firstSeenAt:old?.id===e.id ? old.firstSeenAt : e.receivedAt};
  }
  async weather() {
    const now=this.clock();
    const aviation=(async()=>{
      try {
        // One small batch for the five stations; not a query per station.
        const r=await this.read(`${AV}/api/data/metar?ids=${this.cfg.stations.join(',')}&format=json&hours=30`);
        if(!Array.isArray(r.data)) throw new Error('Expected METAR array');
        let n=0; const ids=[];
        for(const o of r.data) for(const e of C.parseMetar(o,Date.parse(r.receivedAt))) {
          if(this.cfg.stations.includes(e.station)){this.remember(e);ids.push(e.id);n++;}
        }
        this.state.sourceChecks.aviation={checkedAt:r.receivedAt,ok:n>0,records:n,evidenceIds:ids};
        if(!n) this.warnings.push('AviationWeather returned no usable station/extrema evidence');
      } catch(e) {this.errors.push('Weather: '+e.message);this.state.sourceChecks.aviation={...this.state.sourceChecks.aviation,ok:false,error:e.message};}
    })();
    const cliJobs=[];
    if(now-this.lastCliAttempt>=this.cfg.cliRefreshSeconds*1000) {
      this.lastCliAttempt=now;
      for(const station of this.cfg.stations) cliJobs.push((async()=>{
        const key='cli:'+station;
        try {
          const list=await this.read(`${NWS}/products/types/CLI/locations/${C.STATIONS[station].cli}`);
          if(!Array.isArray(list.data['@graph'])) throw new Error('Expected NWS product list');
          const rows=list.data['@graph'].filter(p=>p.id&&Date.parse(p.issuanceTime)<=this.clock())
            .sort((a,b)=>Date.parse(b.issuanceTime)-Date.parse(a.issuanceTime)).slice(0,8);
          let n=0; const ids=[];
          for(const p of rows) {
            let rec=this.cliCache[p.id];
            if(!rec) {
              const r=await this.read(`${NWS}/products/${encodeURIComponent(p.id)}`);
              const prod={...r.data,id:p.id,issuanceTime:r.data.issuanceTime||p.issuanceTime};
              rec=C.parseCLI(prod,station,Date.parse(r.receivedAt));
              if(rec) this.cliCache[p.id]=rec; // Never cache a transient failure as permanently bad.
            }
            if(rec&&rec.station===station) { this.remember({...rec,receivedAt:C.iso(this.clock())});ids.push(rec.id);n++; }
          }
          if(!n) throw new Error('No parseable station-specific CLI in latest product list');
          this.state.sourceChecks[key]={checkedAt:list.receivedAt,ok:true,records:n,evidenceIds:ids};
        } catch(e) {this.errors.push(`${station} CLI: ${e.message}`);this.state.sourceChecks[key]={...this.state.sourceChecks[key],ok:false,error:e.message};}
      })());
    }
    await Promise.all([aviation,...cliJobs]);
  }
  async discover() {
    if(this.clock()-this.lastDiscoveryAttempt<this.cfg.discoverySeconds*1000&&this.markets.length) return;
    this.lastDiscoveryAttempt=this.clock();
    const events=new Map(); let complete=true;
    try {
      const seenPages=new Set();
      for(let page=1;page<=this.cfg.discoveryMaxPages;page++) {
        const u=new URL(MARKET+'/v1/search');u.searchParams.set('query','highest temperature');
        u.searchParams.set('limit',String(this.cfg.discoveryPageSize));u.searchParams.set('page',String(page));
        const r=await this.read(u.href);
        if(!Array.isArray(r.data.events)) throw new Error('Expected public search events array');
        const list=r.data.events;
        if(!list.length) break;
        const fingerprint=C.hash(list.map(e=>e.slug));
        if(seenPages.has(fingerprint)) {complete=false;break;} seenPages.add(fingerprint);
        for(const e of list) if(e.slug) events.set(e.slug,e);
        if(list.length<this.cfg.discoveryPageSize) break;
        if(page===this.cfg.discoveryMaxPages) complete=false;
      }
      for(const slug of this.cfg.eventSlugs) {
        const r=await this.read(MARKET+'/v1/events/slug/'+slug);
        if(!r.data.event?.slug) throw new Error('Configured event not found: '+slug);
        events.set(slug,r.data.event);
      }
      const records=[],rejected=[];
      for(let event of events.values()) {
        if(!Array.isArray(event.markets)||!event.markets.length) {
          const r=await this.read(MARKET+'/v1/events/slug/'+encodeURIComponent(event.slug));
          event=r.data.event || event;
        }
        for(const m of event.markets||[]) {
          const parsed=C.parseMarket(m,event,this.clock());
          if(!parsed.station||!this.cfg.stations.includes(parsed.station)) {
            if(/highest.*temperature/i.test(parsed.question) && !parsed.valid) {
              const reason={slug:parsed.slug,issues:parsed.issues};
              rejected.push(reason);this.log('DISCOVERY_REJECTED',reason);
            }
            continue;
          }
          const today=C.day(this.clock(),parsed.station);
          if(parsed.date && (parsed.date<C.addDay(today,-1)||parsed.date>C.addDay(today,1))) continue;
          // Retain rule failures for visibility, but never turn them into entries.
          records.push({...parsed,eventContext:{slug:event.slug,description:event.description||'',resolutionSource:event.resolutionSource||'',closed:event.closed}});
        }
      }
      const unique=[...new Map(records.map(m=>[m.slug,m])).values()];
      unique.sort((a,b)=>{
        const priority=m=>m.date===C.day(this.clock(),m.station)?0:m.date>C.day(this.clock(),m.station)?1:2;
        return priority(a)-priority(b)||a.slug.localeCompare(b.slug);
      });
      if(unique.length>this.cfg.maxMarketsPerCycle) {complete=false;this.warnings.push('Market cap reached; some markets not sampled');}
      this.markets=unique.slice(0,this.cfg.maxMarketsPerCycle);
      this.state.discovery={at:C.iso(this.clock()),ok:true,complete,eventCount:events.size,matched:unique.length,watched:this.markets.length,rejectedCount:rejected.length,rejections:rejected.slice(0,20)};
      this.raw('MARKET_RULES',{markets:this.markets},'market-rules-'+C.iso(this.clock()).slice(0,10));
      if(!complete) this.warnings.push('Discovery was capped or pagination repeated; market coverage is incomplete');
      if(!this.markets.length) this.warnings.push('No supported markets matched. This is not proof there are no opportunities; inspect discovery diagnostics.');
    } catch(e) {
      this.errors.push('Discovery: '+e.message);
      this.state.discovery={...this.state.discovery,ok:false,error:e.message,attemptAt:C.iso(this.clock())};
      this.markets=[]; // Never quietly use stale market mappings after discovery fails.
    }
  }
  markRules(m) {
    const base=this.state.ruleBaselines[m.slug];
    if(!base&&m.valid) this.state.ruleBaselines[m.slug]=m.rulesHash;
    m.rulesChanged=!!base&&base!==m.rulesHash;
    if(m.rulesChanged) this.warnings.push('Rules changed for '+m.slug+'; paper entry paused for manual review');
    return m;
  }
  weatherFresh(station,e) {
    if(!e) return false;
    const s=this.state.sourceChecks[e.kind.startsWith('CLI_')?'cli:'+station:'aviation'];
    return s?.ok===true&&Array.isArray(s.evidenceIds)&&s.evidenceIds.includes(e.id)
      &&this.clock()-Date.parse(s.checkedAt)<=this.cfg.maxWeatherCheckAgeSeconds*1000;
  }
  async book(m) {
    const r=await this.read(MARKET+'/v1/markets/'+encodeURIComponent(m.slug)+'/book');
    const b=C.parseBook(r.data,m.slug,Date.parse(r.receivedAt),this.cfg.maxBookAgeSeconds);
    this.raw('BOOK',{market:m.slug,requestStartedAt:r.startedAt,receivedAt:r.receivedAt,durationMs:r.durationMs,
      asOf:b.asOf,state:b.state,hash:b.hash,
      bids:b.bids.slice(0,this.cfg.bookArchiveLevels),offers:b.offers.slice(0,this.cfg.bookArchiveLevels),
      noAsks:b.noAsks.slice(0,this.cfg.bookArchiveLevels),depthTruncated:b.bids.length>this.cfg.bookArchiveLevels||b.offers.length>this.cfg.bookArchiveLevels});
    return b;
  }
  async currentMarket(m) {
    const r=await this.read(MARKET+'/v1/market/slug/'+encodeURIComponent(m.slug));
    const raw=r.data.market;
    if(!raw||raw.slug!==m.slug) throw new Error('Expected matching market object on detail endpoint');
    return this.markRules({...C.parseMarket(raw,m.eventContext||{},this.clock()),eventContext:m.eventContext});
  }
  async observeMarket(original) {
    let m=this.markRules(original), book=null;
    try {
      book=await this.book(m);
      let select=C.chooseEvidence(this.state.evidence,m.station,m.date,this.clock());
      if(m.valid&&!select.conflict&&select.evidence&&m.band.high!=null&&select.evidence.floorF>m.band.high&&!this.state.positions[m.slug]) {
        // Re-read rules/status immediately before considering an entry.
        m=await this.currentMarket(m);
        select=C.chooseEvidence(this.state.evidence,m.station,m.date,this.clock());
      }
      const now=this.clock();
      // A slow metadata request must not leave the earlier book eligible indefinitely.
      if(book&&now-Date.parse(book.receivedAt)>this.cfg.maxBookAgeSeconds*1000) {book.valid=false;book.reasons.push('Book response aged while validating rules');}
      const result=C.evaluate(this.state,m,book,select,this.cfg,now,this.weatherFresh(m.station,select.evidence));
      for(const e of result.events) this.log(e.kind,e);
      this.log('MARKET_OBSERVATION',{market:m.slug,station:m.station,date:m.date,rulesHash:m.rulesHash,
        status:result.status,evidenceId:select.evidence?.id||null,floorF:select.evidence?.floorF??null,
        quoteAsOf:book.asOf,quoteReceivedAt:book.receivedAt,noAsk:book.bestNoAsk,
        idealizedNetU:result.quoteCapacity?.netIfNoWinsU??null});
      return {slug:m.slug,question:m.question,url:m.url,station:m.station,date:m.date,band:m.band,
        rulesHash:m.rulesHash,validRules:m.valid,ruleIssues:m.issues,status:result.status,detail:result.detail,
        evidence:select.evidence?{id:select.evidence.id,kind:select.evidence.kind,floorF:select.evidence.floorF,
          issuedAt:select.evidence.issuedAt,observedAt:select.evidence.observedAt,firstSeenAt:select.evidence.firstSeenAt,
          sourceUrl:select.evidence.sourceUrl}:null,weatherConflict:select.conflict,
        book:{asOf:book.asOf,receivedAt:book.receivedAt,ageSeconds:book.ageSeconds,noAsk:book.bestNoAsk,state:book.state,
          valid:book.valid,reasons:book.reasons,topNoAsks:book.noAsks.slice(0,5)},signal:result.signal,
        quoteCapacity:result.quoteCapacity?{qty:result.quoteCapacity.qty,costU:result.quoteCapacity.costU,
          netIfNoWinsU:result.quoteCapacity.netIfNoWinsU,roiIfNoWins:result.quoteCapacity.roiIfNoWins}:null};
    } catch(e) {
      this.errors.push(m.slug+': '+e.message);
      delete this.state.previousBooks[m.slug];
      this.log('MARKET_READ_FAILED',{market:m.slug,error:e.message});
      return {slug:m.slug,question:m.question,url:m.url,station:m.station,date:m.date,band:m.band,
        validRules:m.valid,ruleIssues:m.issues,status:'READ_FAILED',detail:e.message};
    }
  }
  async grade() {
    const ps=Object.values(this.state.positions);
    for(const p of ps) {
      const cli=C.gradeCLI(p,this.state.evidence);
      if(cli&&p.cliGrade?.evidenceId!==cli.evidenceId) {
        p.cliGrade=cli;this.log('CLI_PAPER_CHECK',{market:p.market,...cli});
      }
      if(this.clock()<C.dayStart(C.addDay(p.date,1),p.station)) continue;
      // Continue checking for revisions for seven days; do not recycle capital from CLI alone.
      if(this.clock()-C.dayStart(p.date,p.station)>8*86400000 ||
        this.clock()-Date.parse(p.lastSettlementCheck||'1970-01-01')<600000) continue;
      p.lastSettlementCheck=C.iso(this.clock());
      try {
        const r=await this.read(MARKET+'/v1/market/slug/'+p.market);
        if(!r.data.market) throw new Error('Missing market settlement metadata');
        const event=await this.read(MARKET+'/v1/events/slug/'+p.eventSlug);
        if(!event.data.event) throw new Error('Missing event settlement metadata');
        const market=C.parseMarket(r.data.market,event.data.event,this.clock());
        if(!market.closed) continue;
        const book=await this.book(market);
        const settlement=await this.read(MARKET+'/v1/markets/'+p.market+'/settlement');
        this.raw('SETTLEMENT_RESPONSE',{market:p.market,receivedAt:settlement.receivedAt,data:settlement.data,status:market.status,bookState:book.state},'settlement-'+p.market);
        const g=C.gradeExchange(p,settlement.data,market,book,this.clock());
        if(g&&(!p.exchangeGrade||g.netU!==p.exchangeGrade.netU)) {p.exchangeGrade=g;this.log('EXCHANGE_PAPER_GRADE',{market:p.market,...g});}
        else if(!g) p.settlementNote='Exchange finality or settlement schema not established; not counted as settled profit';
      } catch(e) {p.settlementNote=e.message;this.errors.push('Settlement '+p.market+': '+e.message);}
    }
  }
  flush(rows) {
    const now=this.clock(), date=C.iso(now).slice(0,10);
    this.state.cliCache=Object.fromEntries(Object.entries(this.cliCache).sort((a,b)=>Date.parse(b[1].issuedAt)-Date.parse(a[1].issuedAt)).slice(0,100));
    const cutoff=C.iso(now-9*86400000).slice(0,10);
    // Only rolling live evidence is pruned. Audit archives and all paper positions remain.
    for(const [key,e] of Object.entries(this.state.evidence)) if(e.date<cutoff) delete this.state.evidence[key];
    this.state.updatedAt=C.iso(now);
    if(this.state.configHash!==C.hash(this.cfg)) {this.log('CONFIG_VERSION',{hash:C.hash(this.cfg),config:this.cfg});this.state.configHash=C.hash(this.cfg);}
    const all=Object.values(this.state.positions), closed=all.filter(p=>p.exchangeGrade);
    const open=all.filter(p=>!p.exchangeGrade);
    const realized=closed.reduce((n,p)=>n+p.exchangeGrade.netU,0);
    const openCost=open.reduce((n,p)=>n+p.costU,0);
    const stationStatus=this.cfg.stations.map(st=>{
      const today=C.day(now,st), sel=C.chooseEvidence(this.state.evidence,st,today,now);
      const advisory=Object.values(this.state.evidence).filter(e=>e.station===st&&e.date===today&&e.kind==='HOURLY_ADVISORY')
        .sort((a,b)=>b.temperatureF-a.temperatureF)[0];
      return {station:st,date:today,floorF:sel.evidence?.floorF??null,kind:sel.evidence?.kind||null,conflict:sel.conflict,
        reason:sel.reason||null,hourlyMaxAdvisoryF:advisory?.temperatureF??null,
        fresh:this.weatherFresh(st,sel.evidence)};
    });
    const last=C.iso(now);
    const summary={startingCashU:C.units(this.cfg.paperStartingCash),paperEntries:all.length,exchangeGraded:closed.length,
      openPaperPositions:open.length,openCostU:openCost,paperCashAvailableU:C.units(this.cfg.paperStartingCash)+realized-openCost,
      exchangeGradedPaperNetU:realized,cliChecked:all.filter(p=>p.cliGrade).length,
      cliContradictions:all.filter(p=>p.cliGrade&&!p.cliGrade.noWouldWin).length,
      openNetIfNoWinsU:open.reduce((n,p)=>n+p.netIfNoWinsU,0)};
    const records=[...this.rawCycle,...this.pendingLogs];
    if(records.length) {
      fs.mkdirSync(path.join(this.out,'history'),{recursive:true});
      // Concatenated gzip members are standard gzip and reduce committed log growth.
      fs.appendFileSync(path.join(this.out,'history',date+'.jsonl.gz'),zlib.gzipSync(records.map(x=>JSON.stringify(x)).join('\n')+'\n',{level:6}));
    }
    this.rawCycle=[];this.pendingLogs=[];
    atomic(path.join(this.out,'state.json'),this.state);
    const snap={schemaVersion:1,version:'1.0.0',mode:'PAPER_ONLY',generatedAt:last,
      transport:'Unauthenticated Polymarket US REST snapshots; no WebSocket',
      liveOrdersPossible:false,config:this.cfg,summary,stations:stationStatus,markets:rows,
      positions:all.slice().reverse().slice(0,200),positionDisplayLimited:all.length>200,
      errors:[...new Set(this.errors)],warnings:[...new Set([...this.warnings,...(C.feeIssue(this.cfg,now)?[C.feeIssue(this.cfg,now)]:[])])],
      discovery:this.state.discovery||null,sourceChecks:this.state.sourceChecks,
      lastCycleGapSeconds:this.lastGap??null,
      caveat:'Hypothetical fills and conditional returns only. Published evidence can be corrected. Book liquidity may disappear. CLI check is not exchange settlement.'};
    atomic(path.join(this.out,'latest.json'),snap);
    atomic(path.join(this.out,'status.json'),{lastRunAt:last,ok:this.errors.length===0,mode:'PAPER_ONLY',errors:snap.errors,
      watched:rows.length,validBooks:rows.filter(r=>r.book?.valid).length,discovery:snap.discovery,summary});
    return snap;
  }
  async cycle() {
    this.errors=[];this.warnings=[];
    const started=this.clock();
    this.lastGap=this.state.lastCycleAt ? (started-Date.parse(this.state.lastCycleAt))/1000:null;
    this.state.lastCycleAt=C.iso(started);
    await Promise.all([this.weather(),this.discover()]);
    const rows=[];
    // Intentional sequential evaluation gives deterministic capital allocation.
    for(const m of this.markets) rows.push(await this.observeMarket(m));
    await this.grade();
    this.log('CYCLE',{durationSeconds:(this.clock()-started)/1000,gapSeconds:this.lastGap,watched:rows.length,errors:this.errors});
    const snap=this.flush(rows);
    console.log(JSON.stringify({at:snap.generatedAt,mode:'PAPER_ONLY',watched:rows.length,
      validBooks:rows.filter(r=>r.book?.valid).length,paperEntries:snap.summary.paperEntries,errors:snap.errors,warnings:snap.warnings}));
    return snap;
  }
}
module.exports={Collector,createClient,allowedURL,atomic,readJSON};
