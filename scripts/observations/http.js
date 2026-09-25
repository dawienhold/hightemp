'use strict';
// No credentials, financial endpoints or third-party subscriptions.
const ALLOW={
 'aviationweather.gov':/^\/api\/data\/metar$/,
 'api.weather.gov':/^\/(?:stations\/K[A-Z0-9]{3}\/observations|products\/types\/CLI\/locations\/[A-Z]{3}|products\/[A-Za-z0-9-]+)$/,
 'tgftp.nws.noaa.gov':/^\/data\/(?:observations\/metar\/stations\/K[A-Z0-9]{3}\.TXT|raw\/cx\/cxus41\.kokx\.dsm\.nyc\.txt)$/,
 'forecast.weather.gov':/^\/product\.php$/
};
function allowed(url){const u=new URL(url);if(u.protocol!=='https:'||u.username||u.password||u.port||!ALLOW[u.hostname]?.test(u.pathname))throw Error('Weather-only GET allowlist rejected URL');return u;}
const wait=ms=>new Promise(r=>setTimeout(r,ms));
function client(cfg,transport=global.fetch,clock=Date.now,blockedUntil={}) {
 const cooldown={get:k=>blockedUntil[k],set:(k,v)=>{blockedUntil[k]=v;}},tails=new Map();
 return async function read(url,format='json') {
  const u=allowed(url),host=u.hostname;
  if((cooldown.get(host)||0)>clock())throw Error('Provider cooling down after rate/access/server error');
  const prev=tails.get(host)||Promise.resolve();
  const gate=prev.then(()=>wait(250));tails.set(host,gate.catch(()=>{}));await gate;
  if((cooldown.get(host)||0)>clock())throw Error('Provider cooling down after rate/access/server error');
  const startedAt=clock();
  const controller=new AbortController();
  let timer;
  try{
   const timeout=new Promise((_,reject)=>{timer=setTimeout(()=>{controller.abort();reject(Error('Weather request timeout'));},cfg.requestTimeoutMs);});
   const operation=(async()=>{
    const r=await transport(u.href,{method:'GET',redirect:'error',headers:{Accept:format==='json'?'application/geo+json,application/json':'text/plain,text/html',
     'User-Agent':'hightemp-observation-research (github.com/dawienhold/hightemp)'},signal:controller.signal});
    if(!r.ok&&r.status!==204){
     if(r.status===429||r.status===403||r.status>=500){const h=r.headers?.get('retry-after');const s=Number(h);const retry=Number.isFinite(s)&&s>0?s*1000:Date.parse(h)-clock();cooldown.set(host,clock()+Math.max(60000,Number.isFinite(retry)?retry:0));}
     throw Error('HTTP '+r.status+' '+host+u.pathname);
    }
    const data=r.status===204?(format==='json'?[]:''):format==='json'?await r.json():await r.text();
    const receivedAt=clock();return {data,url:u.href,startedAt:new Date(startedAt).toISOString(),receivedAt:new Date(receivedAt).toISOString(),durationMs:receivedAt-startedAt,
      httpDate:r.headers?.get('date')||null,httpAge:r.headers?.get('age')||null};
   })();
   return await Promise.race([operation,timeout]);
  }finally{clearTimeout(timer);}
 };
}
module.exports={allowed,client};
