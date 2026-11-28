'use strict';
const path = require('node:path');
const {collect} = require('./crypto/collector');
const config = require('./crypto/config.json');
collect(path.join(__dirname, '..'), config).then(s => {
  console.log(JSON.stringify({at: s.collectedAt, health: s.health, markets: s.markets.length,
    models: Object.fromEntries(Object.entries(s.assets).map(([a, v]) => [a, v.model.status])),
    paperTrades: s.stats.openTrades + s.stats.settledTrades, errors: s.errors}));
  if (!Object.values(s.assets).some(a => a.spot && a.model.status === 'PROVISIONAL')) process.exitCode = 1;
}).catch(e => {console.error('Crypto research collection failed: ' + e.message); process.exitCode = 1;});
