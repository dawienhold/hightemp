'use strict';
const fs = require('node:fs');
const path = require('node:path');
function needsCollection(snapshot, status, now, trigger) {
  if (trigger === 'push' || trigger === 'workflow_dispatch') return true;
  const at = Date.parse(snapshot?.collectedAt), age = now - at;
  return !snapshot || snapshot.health !== 'OK' || status?.health === 'FAILED' ||
    !Number.isFinite(age) || age < 0 || age >= 240000 ||
    !snapshot.assets?.btc || !snapshot.assets?.eth;
}
if (require.main === module) {
  const out = path.join(__dirname, '../docs/data/crypto');
  const read = name => {try {return JSON.parse(fs.readFileSync(path.join(out, name), 'utf8'));} catch {return null;}};
  const needed = needsCollection(read('latest.json'), read('status.json'), Date.now(), process.env.CRYPTO_TRIGGER || 'workflow_dispatch');
  if (process.env.GITHUB_OUTPUT) fs.appendFileSync(process.env.GITHUB_OUTPUT, 'needed=' + needed + '\n');
  console.log(needed ? 'Crypto collection needed' : 'Fresh BTC/ETH snapshot already published; skip duplicate collection');
}
module.exports = {needsCollection};
