// One page list for every static menu. Run after adding or renaming a page:
// node tools/sync-nav.js (write), node tools/sync-nav.js --check (verify).
// Links stay usable without JavaScript or a successful data fetch.
const fs = require('node:fs');
const path = require('node:path');
const docs = path.join(__dirname, '../docs');
const pages = [
  ['index.html', 'High-Temp Desk', './'],
  ['bands.html', '2°F Bands'],
  ['observations.html', 'Data inputs'],
  ['consistency.html', 'Contract Consistency', null, false],
  ['edge.html', '10 AM Market Edge'],
  ['openings.html', 'Market Openings'],
  ['shadow.html', 'Shadow Trader', null, false],
  ['nfl.html', 'NFL Rain Watch'],
  ['mlb.html', 'MLB'],
];
const check = process.argv.includes('--check');
const pageFiles = fs.readdirSync(docs).filter(p => p.endsWith('.html'));
for (const file of pageFiles) {
  if (!pages.some(([p]) => p === file)) throw new Error(`Add ${file} to the shared page list.`);
}
let stale = false;
for (const [file] of pages) {
  const target = path.join(docs, file);
  const before = fs.readFileSync(target, 'utf8');
  const navs = before.match(/<nav\b[^>]*>[\s\S]*?<\/nav>/g) || [];
  if (navs.length !== 1) throw new Error(`Expected one page menu in ${file}`);
  const nav = '<nav class="site-nav" aria-label="Pages">\n' + pages.filter(([, , , visible]) => visible !== false).map(([p, label, href]) =>
    `  <a href="${href || p}"${p === file ? ' aria-current="page"' : ''}>${label}</a>`
  ).join('\n') + '\n</nav>';
  let after = before.replace(navs[0], nav);
  const stylesheet = '<link rel="stylesheet" href="nav.css">';
  if (!after.includes(stylesheet)) after = after.replace('</head>', stylesheet + '\n</head>');
  if (!after.includes(stylesheet)) throw new Error(`Missing head in ${file}`);
  if (after !== before) {
    if (check) { console.error(`Navigation needs sync: ${file}`); stale = true; }
    else fs.writeFileSync(target, after);
  }
}
if (stale) process.exitCode = 1;
else console.log(`${pages.length} pages share the complete navigation menu.`);
