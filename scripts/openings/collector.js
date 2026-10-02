'use strict';
const fs=require('node:fs'),path=require('node:path'),zlib=require('node:zlib');
const C=require('../consistency/core.js'),D=require('../consistency/collector.js'),O=require('./core.js');
const BASE='https://gateway.polymarket.us';
const wait=ms=>new Promise(r=>setTimeout(r,ms));
function createReader(cfg,{transport=global.fetch,clock=Date.now,pause=wait}={}) {
  let tail=Promise.resolve(),last=0;
  const metrics={requests:0,errors:0};
  async function read(url) {
    const u=D.allowedURL(url);
    await (tail=tail.catch(()=>{}).then(async()=>{await pause(Math.max(0,cfg.requestSpacingMs-(clock()-last)));last=clock();}));
    const startedAt=C.iso(clock());metrics.requests++;
    const r=await transport(u.href,{method:'GET',redirect:'error',headers:{Accept:'application/json','Cache-Control':'no-cache','User-Agent':'hightemp-market-openings (github.com/dawienhold/hightemp)'},signal:AbortSignal.timeout(cfg.requestTimeoutSeconds*1000)});
    const receivedAt=C.iso(clock());
    if(!r.ok){metrics.errors++;const e=new Error('HTTP '+r.status+' '+u.pathname);e.status=r.status;throw e;}
    const str=await r.text();if(str.length>8_000_000)throw new Error('Unexpectedly large response');
    return {data:JSON.parse(str),startedAt,receivedAt,url:u.href,httpDate:r.headers?.get('date')||null,httpAge:r.headers?.get('age')||null};
  }
  read.metrics=metrics;return read;
}
function readJSON(file,fallback) {return D.readJSON(file,fallback);}
function validate(cfg) {
  if(cfg.venue!=='POLYMARKET_US'||!Array.isArray(cfg.stations)||cfg.stations.some(s=>!O.ZONES[s])||new Set(cfg.stations).size!==cfg.stations.length)throw new Error('Invalid station/venue configuration');
  for(const [key,low,high] of [['requestTimeoutSeconds',2,15],['requestSpacingMs',250,2000],['searchPageSize',1,100],['searchMaxPages',1,6],['maxEventsPerRun',5,20],['maxRunSeconds',30,180],['indexDays',7,90]])if(!Number.isInteger(cfg[key])||cfg[key]<low||cfg[key]>high)throw new Error('Invalid '+key);
  return cfg;
}
class Collector {
  constructor(root,cfg,{read,clock=Date.now}={}) {
    this.cfg=validate(cfg);this.clock=clock;this.read=read||createReader(cfg);this.out=path.join(root,'docs/data/openings');
    this.state=readJSON(path.join(this.out,'state.json'),{schemaVersion:1,startedAt:C.iso(clock()),events:{},watch:{}});
    if(this.state.schemaVersion!==1||!this.state.events||!this.state.watch)throw new Error('Unknown tracker state; refusing to reset');
    this.mapping={...require('../consistency/config.json'),stations:cfg.stations};
    this.logs=[];this.errors=[];this.warnings=[];this.events=new Map();
  }
  log(kind,data){this.logs.push({kind,at:C.iso(this.clock()),...data});}
  async get(url){if(this.clock()>=this.deadline)throw new Error('Collection time budget exhausted');return this.read(url);}
  load(slug){
    if(!C.slugOK(slug))throw new Error('Invalid event file identifier');
    if(!this.events.has(slug)){
      const e=readJSON(path.join(this.out,'events',slug+'.json'),null);
      if(this.state.events[slug]&&!e)throw new Error('Tracked event file missing: '+slug);
      this.events.set(slug,e);
    }
    return this.events.get(slug);
  }
  async discover() {
    const found=new Map(),seen=new Set();let complete=true;
    for(let page=1;page<=this.cfg.searchMaxPages;page++) {
      try {
        const r=await this.get(`${BASE}/v1/search?query=highest%20temperature&limit=${this.cfg.searchPageSize}&page=${page}`);
        if(!Array.isArray(r.data.events))throw new Error('Missing search events');
        const rows=r.data.events,h=C.hash(rows.map(e=>e.slug));
        if(rows.length&&seen.has(h)){complete=false;this.warnings.push('Discovery repeated a page; absence is unconfirmed');break;}
        seen.add(h);for(const e of rows)if(C.slugOK(e.slug))found.set(e.slug,e);
        if(rows.length<this.cfg.searchPageSize)break;
        if(page===this.cfg.searchMaxPages){complete=false;this.warnings.push('Discovery page limit reached; absence is unconfirmed');}
      }catch(e){complete=false;this.errors.push('Discovery: '+e.message);break;}
    }
    this.discovery={at:C.iso(this.clock()),complete,eventsReturned:found.size};
    const chosen=new Map();
    // Search results are verified from their rules, never from the title alone.
    for(const e of found.values()) {
      const ms=(e.markets||[]).map(m=>C.parseMarket(m,e,this.clock(),this.mapping));
      const m=ms.find(m=>m.valid&&m.metric==='high');if(!m)continue;
      const tomorrow=O.addDay(O.localParts(this.clock(),m.station).date);
      if(m.date===tomorrow||this.state.events[e.slug])chosen.set(e.slug,{station:m.station,date:m.date,searchListed:true});
    }
    for(const [slug,s] of Object.entries(this.state.events))if(O.samplingDue(s,this.clock()))chosen.set(slug,{station:s.station,date:s.date,tracked:true});
    // Verified descriptions determine station/date. Known slugs are just an
    // extra discovery probe and do not substitute for rule verification.
    for(const station of this.cfg.stations) {
      const date=O.addDay(O.localParts(this.clock(),station).date),slug=`temp-${station.slice(1).toLowerCase()}high-${date}`;
      if(!chosen.has(slug))chosen.set(slug,{station,date,probe:true,searchListed:found.has(slug)});
    }
    const list=[...chosen].filter(([slug,h])=>!this.state.events[slug]||O.samplingDue(this.state.events[slug],this.clock()));
    list.sort((a,b)=>Number(!a[1].tracked)-Number(!b[1].tracked));
    if(list.length>this.cfg.maxEventsPerRun){this.warnings.push('Event limit reached; some checks omitted');this.discovery.complete=false;}
    return list.slice(0,this.cfg.maxEventsPerRun);
  }
  async inspect(slug,hint) {
    let response;
    try {response=await this.get(`${BASE}/v1/events/slug/${slug}`);}
    catch(e) {
      // Absence requires both a successful complete search and an explicit 404.
      // A network error, 403, timeout or incomplete search never advances it.
      if(e.status===404&&hint.probe&&this.discovery.complete&&!hint.searchListed&&!this.state.events[slug]) {
        const key=hint.station+'|'+hint.date;
        this.state.watch[key]={lastAbsentAt:C.iso(this.clock()),source:'complete search + expected event 404'};
        this.log('ABSENT',{station:hint.station,date:hint.date,slug});return;
      }
      this.errors.push(slug+': '+e.message);return;
    }
    const raw=response.data.event;
    if(!raw||raw.slug!==slug||!Array.isArray(raw.markets)||raw.markets.length>32||new Set(raw.markets.map(m=>m.slug)).size!==raw.markets.length)throw new Error('Invalid or incomplete event detail '+slug);
    const parsed=raw.markets.map(m=>({raw:m,m:C.parseMarket(m,raw,Date.parse(response.receivedAt),this.mapping)}));
    const valid=parsed.filter(x=>x.m.valid&&x.m.metric==='high'),id=valid[0]?.m;
    if(!id){this.warnings.push(slug+': no verified weather bands');this.log('REJECTED_EVENT',{slug,issues:parsed.map(x=>x.m.issues)});return;}
    if(valid.some(x=>x.m.station!==id.station||x.m.date!==id.date))throw new Error('Mixed station/date rules in '+slug);
    let e=this.load(slug);
    if(!e&&id.date!==O.addDay(O.localParts(this.clock(),id.station).date))return;
    if(e&&(e.station!==id.station||e.date!==id.date))throw new Error('Contract identity changed '+slug);
    const watch=this.state.watch[id.station+'|'+id.date];
    if(!e) {
      e={schemaVersion:1,slug,station:id.station,date:id.date,timeZone:O.ZONES[id.station],title:C.text(raw.title),url:id.url,
        providerCreatedAt:raw.createdAt||raw.creationDate||null,firstSeenAt:response.receivedAt,lastAbsentAt:watch?.lastAbsentAt||null,
        capture:watch?.lastAbsentAt?'BRACKETED':'UNBRACKETED_BASELINE',trackerStartedAt:this.state.startedAt,firstQuoteAt:null,lastSampleAt:null,markets:{}};
      this.events.set(slug,e);this.log('FIRST_LISTING',{slug,station:e.station,date:e.date,firstSeenAt:e.firstSeenAt,lastAbsentAt:e.lastAbsentAt,capture:e.capture,providerCreatedAt:e.providerCreatedAt});
    }
    e.rejected=parsed.filter(x=>!x.m.valid).map(x=>({slug:x.m.slug,issues:x.m.issues}));
    if(e.rejected.length)this.warnings.push(slug+': '+e.rejected.length+' band(s) require rule review');
    const lastDetailsAt=e.lastDetailsAt,previousSlugs=e.listedSlugs||[];
    for(const {raw:r,m} of valid) {
      let market=e.markets[m.slug];
      if(!market) {
        market=e.markets[m.slug]={slug:m.slug,label:m.label,band:m.band,description:m.description,rulesHash:m.rulesHash,
          providerCreatedAt:r.createdAt||null,firstSeenAt:response.receivedAt,lastAbsentAt:lastDetailsAt&&!previousSlugs.includes(m.slug)?lastDetailsAt:e.lastAbsentAt,
          capture:(lastDetailsAt&&!previousSlugs.includes(m.slug))||e.lastAbsentAt?'BRACKETED':'UNBRACKETED_BASELINE',firstQuoteAt:null,quotes:[],ruleChanges:[]};
        this.log('FIRST_BAND',{event:slug,...Object.fromEntries(Object.entries(market).filter(([k])=>k!=='quotes'))});
      }
      if(market.rulesHash!==m.rulesHash) {
        if(market.ruleChanges.at(-1)?.hash!==m.rulesHash)market.ruleChanges.push({at:response.receivedAt,hash:m.rulesHash,description:m.description});
        market.rulesChanged=true;this.warnings.push(m.slug+': rules changed; price series paused');continue;
      }
      if(market.rulesChanged){this.warnings.push(m.slug+': price series remains paused after a rule change');continue;}
      market.active=m.active;
      if(!m.active){market.quotes.push({at:response.receivedAt,usable:false,issues:['MARKET_INACTIVE'],phase:O.phase(e,this.clock())});continue;}
      try {
        const r=await this.get(`${BASE}/v1/markets/${m.slug}/book`),q=O.parseQuote(r.data,m.slug,r.receivedAt,{url:r.url,startedAt:r.startedAt,httpDate:r.httpDate,httpAge:r.httpAge});
        q.phase=O.phase(e,Date.parse(q.at));market.quotes.push(q);
        if(q.usable&&!market.firstQuoteAt){market.firstQuoteAt=q.at;if(!e.firstQuoteAt)e.firstQuoteAt=q.at;this.log('FIRST_USABLE_QUOTE',{event:slug,market:m.slug,quote:q});}
        this.log('QUOTE',{event:slug,market:m.slug,quote:q});
      }catch(err) {
        const q={at:C.iso(this.clock()),usable:false,issues:['BOOK_REQUEST_FAILED'],error:err.message,phase:O.phase(e,this.clock())};
        market.quotes.push(q);this.errors.push(m.slug+': '+err.message);this.log('QUOTE_GAP',{event:slug,market:m.slug,quote:q});
      }
    }
    // Preserve all bands even if omitted on a later successful detail response.
    for(const m of Object.values(e.markets))if(!valid.some(x=>x.m.slug===m.slug))m.missingFromLatestDetail=true;else delete m.missingFromLatestDetail;
    e.listedSlugs=raw.markets.map(m=>m.slug);e.lastDetailsAt=response.receivedAt;e.lastSampleAt=C.iso(this.clock());
    e.nextTargetMinutes=e.firstQuoteAt&&this.clock()-Date.parse(e.firstQuoteAt)>65*O.MIN?15:5;
  }
  save(started) {
    const now=this.clock(),cutoff=O.addDay(C.iso(now).slice(0,10),-this.cfg.indexDays),summaries=[];
    for(const [slug,e] of this.events)if(e) {
      const summary=O.summarizeEvent(e,now);this.state.events[slug]=summary;
      D.atomic(path.join(this.out,'events',slug+'.json'),e);
    }
    for(const [slug,s] of Object.entries(this.state.events)) {
      if(s.date<cutoff){delete this.state.events[slug];continue;}
      // A missed run must turn an expired pending checkpoint into MISSING even
      // when that event no longer needs HTTP requests after the morning cutoff.
      for(const m of s.markets||[])for(const [key,cp] of Object.entries(m.checkpoints||{})) {
        const target=Date.parse(cp.targetAt||''),grace=(key.startsWith('local')?20:10)*O.MIN;
        if(cp.status!=='RECORDED'&&Number.isFinite(target)&&now>target+grace)cp.status='MISSING';
      }
      s.phase=O.phase(s,now);summaries.push(s);
    }
    for(const key of Object.keys(this.state.watch))if(key.slice(-10)<cutoff)delete this.state.watch[key];
    this.state.lastRunAt=C.iso(now);
    const waiting=this.cfg.stations.map(station=>{const date=O.addDay(O.localParts(now,station).date),found=summaries.filter(e=>e.station===station&&e.date===date);return {station,date,status:found.length?'LISTED':this.discovery.complete?'NOT_YET_OBSERVED':'DISCOVERY_INCOMPLETE',lastAbsentAt:this.state.watch[station+'|'+date]?.lastAbsentAt||null};});
    const snap={schemaVersion:1,version:this.cfg.version,venue:this.cfg.venue,startedAt:this.state.startedAt,generatedAt:C.iso(now),durationSeconds:(now-started)/1000,
      previousRunAt:this.previousRunAt,runGapMinutes:this.previousRunAt?(started-Date.parse(this.previousRunAt))/O.MIN:null,
      health:this.errors.length?'PARTIAL':this.discovery.complete?'OK':'PARTIAL',errors:this.errors,warnings:this.warnings,discovery:this.discovery,
      sampling:{discoveryMinutes:5,firstHourMinutes:5,overnightMinutes:15,stopLocalHour:10,checkpointToleranceMinutes:10},waiting,
      events:summaries.sort((a,b)=>b.date.localeCompare(a.date)||a.station.localeCompare(b.station)),requests:this.read.metrics||null,
      note:'First seen is an observation, not an exchange opening timestamp. Initial unbracketed listings are baselines. YES/NO quotes are executable top-of-book prices; midpoints are indicative. All times and gaps are retained. No quotes are interpolated.'};
    this.log('RUN',{generatedAt:snap.generatedAt,health:snap.health,discovery:snap.discovery,errors:snap.errors,warnings:snap.warnings});
    const file=path.join(this.out,'history',C.iso(now).slice(0,10)+'.jsonl.gz');fs.mkdirSync(path.dirname(file),{recursive:true});fs.appendFileSync(file,zlib.gzipSync(this.logs.map(x=>JSON.stringify(x)).join('\n')+'\n'));
    D.atomic(path.join(this.out,'state.json'),this.state);D.atomic(path.join(this.out,'latest.json'),snap);D.atomic(path.join(this.out,'status.json'),{generatedAt:snap.generatedAt,health:snap.health,errors:snap.errors,warnings:snap.warnings});
    return snap;
  }
  async run() {
    const started=this.clock();this.previousRunAt=this.state.lastRunAt||null;this.deadline=started+this.cfg.maxRunSeconds*1000;
    const chosen=await this.discover();
    for(const [slug,hint] of chosen)try{await this.inspect(slug,hint);}catch(e){this.errors.push(e.message);}
    return this.save(started);
  }
}
module.exports={Collector,createReader,validate};
