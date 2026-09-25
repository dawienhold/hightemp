'use strict';
const fs=require('node:fs'),path=require('node:path'),zlib=require('node:zlib');
const C=require('./core.js'),B=require('./books.js');
const BASE='https://gateway.polymarket.us';
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
function allowedURL(input) {
  const u=new URL(input);
  if(u.protocol!=='https:'||u.hostname!=='gateway.polymarket.us'||u.port||u.username||u.password||u.hash||
    !/^\/v1\/(?:search|events\/slug\/[a-z0-9-]+|market\/slug\/[a-z0-9-]+|markets\/[a-z0-9-]+\/book)$/.test(u.pathname))throw new Error('Read-only public-data allowlist rejected URL');
  const keys=u.pathname==='/v1/search'?['query','page','limit']:[];
  for(const k of u.searchParams.keys())if(!keys.includes(k))throw new Error('Unexpected public-data query parameter');
  return u;
}
function createClient(cfg,{transport=global.fetch,clock=Date.now,wait=sleep}={}) {
  let tail=Promise.resolve(),last=0;
  const metrics={requests:0,errors:0};
  async function gate(){const p=tail.then(async()=>{await wait(Math.max(0,cfg.requestSpacingMs-(clock()-last)));last=clock();});tail=p.catch(()=>{});await p;}
  async function read(url) {
    const u=allowedURL(url);
    for(let attempt=0;attempt<2;attempt++) {
      await gate();const startedAt=clock();metrics.requests++;
      let r;
      try {
        // The only financial-network operation: unsigned public GET. No key loader,
        // signer, order endpoint, wallet, or switch that enables live trading.
        r=await transport(u.href,{method:'GET',redirect:'error',headers:{Accept:'application/json',
          'User-Agent':'hightemp-consistency-observer (github.com/dawienhold/hightemp)','Cache-Control':'no-cache'},
          signal:AbortSignal.timeout(cfg.requestTimeoutSeconds*1000)});
        if((r.status===429||r.status>=500)&&attempt===0){
          const h=r.headers?.get('retry-after');
          const sec=h==null?1:/^\d+(?:\.\d+)?$/.test(h)?Number(h):Math.ceil((Date.parse(h)-clock())/1000);
          if(!Number.isFinite(sec)||sec>8)throw new Error('Server requests longer retry wait; observation skipped');
          await wait(Math.max(1,sec)*1000);continue;
        }
        if(!r.ok)throw new Error('HTTP '+r.status);
        const str=await r.text();if(str.length>8_000_000)throw new Error('Unexpectedly large response');
        const data=r.status===204?{}:JSON.parse(str);const receivedAt=clock();
        return {data,url:u.href,startedAt:C.iso(startedAt),receivedAt:C.iso(receivedAt),durationMs:receivedAt-startedAt,
          httpDate:r.headers?.get('date')||null,httpAge:r.headers?.get('age')||null,cacheControl:r.headers?.get('cache-control')||null};
      }catch(e){metrics.errors++;throw new Error(u.pathname+': '+e.message);}
    }
    throw new Error('Request failed');
  }
  read.metrics=metrics;return read;
}
function readJSON(file,fallback){try{return JSON.parse(fs.readFileSync(file,'utf8'));}catch(e){if(e.code==='ENOENT')return fallback;throw new Error('Refusing to reset unreadable file '+file+': '+e.message);}}
function atomic(file,obj){fs.mkdirSync(path.dirname(file),{recursive:true});const tmp=file+'.tmp';fs.writeFileSync(tmp,JSON.stringify(obj,null,2)+'\n');fs.renameSync(tmp,file);}
async function mapLimit(list,n,fn){const out=Array(list.length);let pos=0;await Promise.all(Array.from({length:Math.min(n,list.length)},async()=>{while(pos<list.length){const i=pos++;out[i]=await fn(list[i],i);}}));return out;}
const rankStatus={TWO_SNAPSHOT_CANDIDATE:0,FIRST_SNAPSHOT_ONLY:1,DID_NOT_SURVIVE_STRESS:2,FIRST_EDGE_DISAPPEARED:3,NO_NET_EDGE:4,BLOCKED:5};
function sortResults(a,b){return (rankStatus[a.status]??9)-(rankStatus[b.status]??9)||
  (b.stress?.minimumSurplusU??b.displayed?.minimumSurplusU??b.indicative?.minimumSurplusU??-1e12)-(a.stress?.minimumSurplusU??a.displayed?.minimumSurplusU??a.indicative?.minimumSurplusU??-1e12);}
function freshState(){return {schemaVersion:1,mode:'OBSERVE_ONLY',ruleBaselines:{},episodes:{},counts:{runs:0,displayedObservations:0,twoSnapshotObservations:0},lastRunAt:null};}
class Collector {
  constructor(root,cfg,{read,clock=Date.now,wait=sleep}={}) {
    this.root=root;this.cfg=C.validateConfig(cfg);this.clock=clock;this.wait=wait;
    this.out=path.join(root,'docs','data','consistency');this.read=read||createClient(cfg);
    this.state=readJSON(path.join(this.out,'state.json'),freshState());
    if(this.state.schemaVersion!==1||this.state.mode!=='OBSERVE_ONLY'||!this.state.ruleBaselines||!this.state.episodes||!this.state.counts)throw new Error('Unknown consistency-state schema; refusing to overwrite');
    this.logs=[];this.errors=[];this.warnings=[];this.results=[];this.groups=[];this.marketRows=[];this.discovery={};this.deadline=Infinity;
  }
  log(kind,data){this.logs.push({at:C.iso(this.clock()),kind,...data});}
  remaining(){return this.deadline-this.clock();}
  async get(url){if(this.remaining()<this.cfg.requestTimeoutSeconds*1000+1000)throw new Error('RUN_TIME_BUDGET_EXHAUSTED');return this.read(url);}
  rules(m){
    const old=Object.hasOwn(this.state.ruleBaselines,m.slug)?this.state.ruleBaselines[m.slug]:null,approve=Object.hasOwn(this.cfg.approvedRuleChanges,m.slug)?this.cfg.approvedRuleChanges[m.slug]:null;
    if(m.valid&&(!old||approve===m.rulesHash)){
      if(old!==m.rulesHash)this.log(old?'RULE_CHANGE_EXPLICITLY_APPROVED':'RULE_BASELINE',{slug:m.slug,from:old||null,to:m.rulesHash});
      this.state.ruleBaselines[m.slug]=m.rulesHash;
    }
    m.rulesChanged=!!old&&old!==m.rulesHash&&approve!==m.rulesHash;
    if(m.rulesChanged)this.log('RULE_CHANGE_REVIEW',{slug:m.slug,previous:old,current:m.rulesHash});
    const file=path.join(this.out,'rules',m.rulesHash+'.json');
    if(!fs.existsSync(file))atomic(file,{schemaVersion:1,firstReceivedAt:m.checkedAt,market:m});
    return m;
  }
  async discover(){
    const found=new Map(),notes=[];let complete=true;
    for(const query of this.cfg.searchQueries){
      const seen=new Set();
      for(let page=1;page<=this.cfg.searchMaxPages;page++){
        try{
          const u=new URL(BASE+'/v1/search');u.searchParams.set('query',query);u.searchParams.set('limit',String(this.cfg.searchPageSize));u.searchParams.set('page',String(page));
          const r=await this.get(u.href);if(!Array.isArray(r.data.events))throw new Error('Expected search events array');
          const es=r.data.events;if(!es.length)break;
          const h=C.hash(es.map(e=>e.slug));if(seen.has(h)){complete=false;notes.push('Search repeated a page');break;}seen.add(h);
          for(const e of es)if(C.slugOK(e.slug))found.set(e.slug,e);
          if(es.length<this.cfg.searchPageSize)break;
          if(page===this.cfg.searchMaxPages){complete=false;notes.push('Search page cap reached');}
        }catch(e){this.errors.push('Discovery: '+e.message);complete=false;break;}
      }
    }
    // Existing Shadow data supplies event identifiers ONLY. Prices, parsed rules,
    // and weather evidence from another process are NOT trusted as current input.
    const shadowFile=path.join(this.root,'docs','data','shadow','latest.json');
    try{
      const s=readJSON(shadowFile,null);
      if(s&&this.clock()-Date.parse(s.generatedAt)<2*86400000)for(const m of s.markets||[]){
        try{const u=new URL(m.url);const slug=u.pathname.match(/^\/event\/([a-z0-9-]+)$/)?.[1];
          if(u.hostname==='polymarket.us'&&C.slugOK(slug)&&!found.has(slug))found.set(slug,{slug,fromShadowIdentifier:true});}catch{}
      }
    }catch(e){notes.push('Optional Shadow identifier cache unreadable: '+e.message);}
    for(const slug of this.cfg.eventSlugs)found.set(slug,{...(found.get(slug)||{}),slug,configured:true});
    const supported=[];
    for(const e of found.values()){
      if(e.closed===true||e.archived===true)continue;
      const parsed=(e.markets||[]).map(m=>C.parseMarket(m,e,this.clock(),this.cfg));
      const hint=parsed.find(m=>m.station&&C.STATIONS[m.station]&&C.validDate(m.date));
      // Date in an event identifier is ONLY a discovery filter, never settlement semantics.
      const date=hint?.date||e.slug.match(/20\d{2}-\d{2}-\d{2}/)?.[0];
      const station=hint?.station;
      const today=station?C.day(this.clock(),station):C.iso(this.clock()-8*3600000).slice(0,10);
      const delta=date?(Date.parse(date)-Date.parse(today))/86400000:null;
      if(!e.configured&&delta!==null&&(delta < -1||delta>1))continue;
      const pri=e.configured?-1:delta===0?0:delta===1?1:delta===-1?2:3;
      supported.push({slug:e.slug,priority:pri,station,date,configured:!!e.configured});
    }
    supported.sort((a,b)=>a.priority-b.priority||a.slug.localeCompare(b.slug));
    const chosen=supported.slice(0,this.cfg.maxEvents);
    if(supported.length>chosen.length){complete=false;notes.push('Event cap reached; '+(supported.length-chosen.length)+' event(s) omitted');}
    this.discovery={checkedAt:C.iso(this.clock()),searchCoverageComplete:complete,foundEvents:found.size,inWindowEvents:supported.length,
      selectedEvents:chosen.length,omittedEvents:supported.slice(chosen.length),notes,
      caveat:'Search coverage, matched rules, and numeric partition coverage are separate. This is not an all-exchange scan.'};
    this.warnings.push(...notes);if(!chosen.length)this.warnings.push('No event identifiers in scope; see provider errors and discovery details');
    return chosen;
  }
  async event(slug){
    const r=await this.get(BASE+'/v1/events/slug/'+slug),event=r.data.event;
    if(!event||event.slug!==slug||!Array.isArray(event.markets))throw new Error('Event detail missing, mismatched, or incomplete schema');
    if(event.markets.length>this.cfg.maxMarketsPerEvent)throw new Error('EVENT_MARKET_CAP: entire event skipped, not silently truncated');
    const seen=new Set();
    for(const m of event.markets){if(seen.has(m.slug))throw new Error('Duplicate market slug in event');seen.add(m.slug);}
    const markets=event.markets.map(m=>this.rules(C.parseMarket(m,event,Date.parse(r.receivedAt),this.cfg)));
    return {event,markets,receivedAt:r.receivedAt};
  }
  async books(markets){
    const pairs=await mapLimit(markets.filter(m=>m.valid&&m.active&&!m.rulesChanged),this.cfg.concurrency,async m=>{
      try{const r=await this.get(BASE+'/v1/markets/'+m.slug+'/book');
        return [m.slug,B.parseBook(r.data,m.slug,Date.parse(r.receivedAt),this.cfg,{startedAt:r.startedAt,receivedAt:r.receivedAt,durationMs:r.durationMs,httpDate:r.httpDate,httpAge:r.httpAge,cacheControl:r.cacheControl})];
      }catch(e){this.errors.push(m.slug+': '+e.message);return [m.slug,null];}
    });return Object.fromEntries(pairs.filter(([,b])=>b));
  }
  async inspectEvent(slug){
    let first;
    try{first=await this.event(slug);}catch(e){this.errors.push(slug+': '+e.message);this.groups.push({eventSlug:slug,status:'EVENT_READ_FAILED',error:e.message});return;}
    // Re-check exact station/date scope from the verified description after discovery.
    const markets=first.markets.filter(m=>!m.station||!C.STATIONS[m.station]||!C.validDate(m.date)||Math.abs(Date.parse(m.date)-Date.parse(C.day(this.clock(),m.station)))<=86400000);
    const fBooks=await this.books(markets),fAt=this.clock();
    const built=C.relations(markets,this.cfg);
    let results=built.relations.map(rel=>B.evaluateRelation(rel,markets,fBooks,fAt,this.cfg));
    this.log('BOOK_SNAPSHOT',{eventSlug:slug,phase:'FIRST',at:C.iso(fAt),books:fBooks,ruleHashes:Object.fromEntries(markets.map(m=>[m.slug,m.rulesHash]))});
    let finalMarkets=markets,finalBooks=fBooks,finalBuilt=built;
    const firstPositive=results.filter(r=>r.displayed);
    if(firstPositive.length&&this.remaining()>this.cfg.confirmationDelaySeconds*1000+this.cfg.requestTimeoutSeconds*1000*2){
      await this.wait(this.cfg.confirmationDelaySeconds*1000);
      try{
        // Whole event rules/status are fetched again BEFORE second books.
        const second=await this.event(slug);finalMarkets=second.markets;
        const sBuilt=C.relations(finalMarkets,this.cfg),sBooks=await this.books(finalMarkets),sAt=this.clock();
        finalBooks=sBooks;finalBuilt=sBuilt;
        const initial=new Map(results.map(r=>[r.id,r]));
        results=sBuilt.relations.map(rel=>{
          const old=initial.get(rel.id);
          const prev=old?.displayed?{at:fAt,books:fBooks,ruleHashes:old.ruleHashes}:null;
          const result=B.evaluateRelation(rel,finalMarkets,sBooks,sAt,this.cfg,prev);
          return old?.displayed&&!result.displayed?{...result,status:'FIRST_EDGE_DISAPPEARED',firstSnapshotDisplayed:old.displayed,firstSnapshotAt:old.at}:result;
        });
        for(const r of firstPositive)if(!results.some(x=>x.id===r.id))results.push({...r,status:'FIRST_EDGE_DISAPPEARED',firstSnapshotDisplayed:r.displayed,firstSnapshotAt:r.at,displayed:null,stress:null,reasons:['RELATION_REMOVED_OR_RULES_CHANGED_ON_RECHECK']});
        this.log('BOOK_SNAPSHOT',{eventSlug:slug,phase:'SECOND',at:C.iso(sAt),books:sBooks,ruleHashes:Object.fromEntries(finalMarkets.map(m=>[m.slug,m.rulesHash]))});
      }catch(e){this.errors.push('Confirmation '+slug+': '+e.message);results=results.map(r=>r.displayed?{...r,status:'FIRST_SNAPSHOT_ONLY',stress:null,reasons:['CONFIRMATION_READ_FAILED']}:r);}
    }else if(firstPositive.length){results=results.map(r=>r.displayed?{...r,reasons:['CONFIRMATION_TIME_BUDGET_EXHAUSTED']}:r);}
    const bookValues=Object.values(finalBooks);
    this.groups.push({eventSlug:slug,title:C.text(first.event.title||first.event.description),status:results.some(r=>r.status==='TWO_SNAPSHOT_CANDIDATE')?'CANDIDATE_OBSERVED':results.length?'SCANNED':'NO_COMPATIBLE_RELATIONS',
      eventMarkets:first.markets.length,inWindowMarkets:markets.length,verifiedMarkets:finalMarkets.filter(m=>m.valid).length,
      activeMarkets:finalMarkets.filter(m=>m.valid&&m.active).length,booksReceived:bookValues.length,validBooks:bookValues.filter(b=>b.valid).length,
      groups:finalBuilt.groups,relationships:results.length,
      rejected:finalMarkets.filter(m=>!m.valid||m.rulesChanged).map(m=>({slug:m.slug,label:m.label,issues:m.issues,rulesChanged:!!m.rulesChanged,rulesHash:m.rulesHash})),
      blockers:countReasons(results)});
    this.marketRows.push(...finalMarkets.map(m=>({slug:m.slug,eventSlug:m.eventSlug,station:m.station,date:m.date,metric:m.metric,label:m.label,valid:m.valid,active:m.active,
      rulesChanged:!!m.rulesChanged,issues:m.issues,rulesHash:m.rulesHash,url:m.url,description:m.description,
      book:finalBooks[m.slug]?{valid:finalBooks[m.slug].valid,issues:finalBooks[m.slug].issues,asOf:finalBooks[m.slug].asOf,receivedAt:finalBooks[m.slug].receivedAt,
        yesAsk:finalBooks[m.slug].yesAsks[0]?.priceU??null,noAsk:finalBooks[m.slug].noAsks[0]?.priceU??null,
        yesQty:finalBooks[m.slug].yesAsks[0]?.qty??0,noQty:finalBooks[m.slug].noAsks[0]?.qty??0}:null})));
    this.results.push(...results);
    for(const r of results)this.record(r);
    this.log('EVENT_SUMMARY',{eventSlug:slug,relationships:results.length,statuses:countStatuses(results),blockers:countReasons(results)});
  }
  record(r){
    if(!r.displayed&&!r.firstSnapshotDisplayed)return;
    const now=this.clock(),previous=this.state.episodes[r.id];
    const ep=previous||{id:r.id,eventSlug:r.eventSlug,station:r.station,date:r.date,type:r.type,firstSeenAt:C.iso(now),observations:0,twoSnapshotObservations:0};
    ep.lastSeenAt=C.iso(now);ep.lastStatus=r.status;ep.observations++;ep.lastMinimumSurplusU=r.stress?.minimumSurplusU??r.displayed?.minimumSurplusU??r.firstSnapshotDisplayed.minimumSurplusU;
    ep.lastBundles=r.stress?.bundles??r.displayed?.bundles??r.firstSnapshotDisplayed.bundles;
    if(r.status==='TWO_SNAPSHOT_CANDIDATE'){ep.twoSnapshotObservations++;this.state.counts.twoSnapshotObservations++;}
    ep.legs=r.legs;this.state.episodes[r.id]=ep;this.state.counts.displayedObservations++;
    this.log('CONDITIONAL_CANDIDATE',{...r,observationOnly:true,notAUniqueTrade:true});
  }
  save(startedAt){
    const now=this.clock(),sorted=this.results.slice().sort(sortResults),positive=sorted.filter(r=>r.displayed||r.firstSnapshotDisplayed),two=positive.filter(r=>r.status==='TWO_SNAPSHOT_CANDIDATE');
    const previous=this.state.lastRunAt;
    this.state.lastRunAt=C.iso(now);this.state.counts.runs++;
    const eps=Object.values(this.state.episodes).sort((a,b)=>b.lastSeenAt.localeCompare(a.lastSeenAt)).slice(0,this.cfg.recentEpisodesLimit);
    this.state.episodes=Object.fromEntries(eps.map(x=>[x.id,x]));
    const review=C.feeIssue(this.cfg,now);if(review)this.warnings.push(review);
    const snapshot={schemaVersion:1,version:this.cfg.version,mode:'OBSERVE_ONLY',liveOrdersPossible:false,generatedAt:C.iso(now),
      startedAt:C.iso(startedAt),durationSeconds:(now-startedAt)/1000,
      previousPublishedAt:previous,runGapSeconds:previous?(startedAt-Date.parse(previous))/1000:null,
      venue:this.cfg.venue,settings:this.cfg,
      summary:{eventsSelected:this.discovery.selectedEvents||0,eventsInspected:this.groups.length,marketsInspected:this.marketRows.length,
        verifiedMarkets:this.marketRows.filter(x=>x.valid).length,booksReceived:this.marketRows.filter(x=>x.book).length,
        validBooks:this.marketRows.filter(x=>x.book?.valid).length,relationshipsChecked:sorted.length,
        displayedLeadsObserved:positive.length,currentDisplayedCandidateBaskets:positive.filter(r=>r.displayed).length,twoSnapshotCandidateBaskets:two.length,
        bestObservedMinimumSurplusU:two[0]?.stress?.minimumSurplusU??null,
        scope:'Within-event, exact-template, integer-Fahrenheit daily CLI markets only',
        noProfitTotal:'Alternative baskets can share liquidity; do not sum their modeled surpluses. No purchases or realized P/L.'},
      health:!this.errors.length&&sorted.length?'OBSERVATIONS_AVAILABLE':sorted.length?'PARTIAL_COVERAGE':'CHECK_PROVIDER_OR_RULE_DIAGNOSTICS',
      discovery:this.discovery,errors:[...new Set(this.errors)],warnings:[...new Set(this.warnings)],groups:this.groups,markets:this.marketRows,
      statusCounts:countStatuses(sorted),blockers:countReasons(sorted),candidates:positive.slice(0,30),candidatesOmitted:Math.max(0,positive.length-30),
      nearMisses:sorted.filter(r=>!r.displayed&&!r.firstSnapshotDisplayed&&r.indicative).slice(0,8),recentEpisodes:eps.slice(0,50),counts:this.state.counts,
      transport:this.read.metrics||null,
      caveat:'All quoted minimum payouts are CONDITIONAL on all legs filling in equal size and numeric settlement under matching rules. Exchange fallback settlement, rules changes, and failed legs are not hedged.'};
    this.log('RUN_SUMMARY',{...snapshot.summary,errors:snapshot.errors,warnings:snapshot.warnings,durationSeconds:snapshot.durationSeconds,runGapSeconds:snapshot.runGapSeconds});
    if(this.logs.length){const file=path.join(this.out,'history',C.iso(now).slice(0,10)+'.jsonl.gz');fs.mkdirSync(path.dirname(file),{recursive:true});
      fs.appendFileSync(file,zlib.gzipSync(this.logs.map(x=>JSON.stringify(x)).join('\n')+'\n',{level:6}));this.logs=[];}
    atomic(path.join(this.out,'state.json'),this.state);atomic(path.join(this.out,'latest.json'),snapshot);
    atomic(path.join(this.out,'status.json'),{generatedAt:snapshot.generatedAt,mode:'OBSERVE_ONLY',health:snapshot.health,summary:snapshot.summary,errors:snapshot.errors,warnings:snapshot.warnings});
    return snapshot;
  }
  async run(){
    const started=this.clock();this.deadline=started+this.cfg.maxRunSeconds*1000;
    const configHash=C.hash(this.cfg);if(this.state.configHash!==configHash){this.log('CONFIG_VERSION',{configHash,config:this.cfg});this.state.configHash=configHash;}
    const events=await this.discover();
    for(let i=0;i<events.length;i++){
      if(this.remaining()<this.cfg.requestTimeoutSeconds*1000+2000){this.warnings.push('Run time budget reached; '+(events.length-i)+' selected event(s) not inspected');this.discovery.runtimeOmittedEvents=events.slice(i);break;}
      await this.inspectEvent(events[i].slug);
    }
    return this.save(started);
  }
}
function countStatuses(rs){const c={};for(const r of rs)c[r.status]=(c[r.status]||0)+1;return c;}
function countReasons(rs){const c={};for(const r of rs)for(const x of new Set(r.reasons||[]))c[x]=(c[x]||0)+1;return c;}
module.exports={allowedURL,createClient,readJSON,atomic,mapLimit,Collector,freshState,countReasons,countStatuses};
