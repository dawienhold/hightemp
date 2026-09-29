// Display regression: curve samples must never replace the card's evidence max.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const html = fs.readFileSync(require('node:path').join(__dirname, '../docs/index.html'), 'utf8');
const source = html.slice(html.indexOf('function dayChart(s)'), html.indexOf('/** Probability of each whole degree'));
const element = (tag, attrs = {}, text = '') => ({
  tag, attrs, textContent: text, children: [],
  appendChild(child) { this.children.push(child); return child; },
});
const ctx = vm.createContext({
  svg: element,
  el: (tag, cls, text) => element(tag, { class: cls }, text),
  f1: v => v.toFixed(1),
});
vm.runInContext(source, ctx);
const flatten = n => [n, ...n.children.flatMap(flatten)];
const render = (curve, today, inferredCurve = []) => flatten(ctx.dayChart({
  station: 'KMDW', curve, inferredCurve,
  today: { i80: [75, 79], point: 77, ...today },
}));
const label = nodes => nodes.find(n => n.attrs.class === 'obs-label')?.textContent;

// Actual Chicago discrepancy: 60.8F display-feed peak vs 57.9F precise high.
const chicago = render([['01:00', 60.8], ['01:53', 57.9], ['05:30', 55.4]],
  { obsMax: 57.9, obsPrecise: true, obsSource: 'hourly tenths' });
assert.equal(label(chicago), '57.9° precise high');
assert(chicago.some(n => String(n.textContent).includes('unverified or coarse precision')));
assert(!chicago.some(n => n.attrs.class === 'obs-dot')); // no invented peak time

// A six-hour maximum may be above every sampled point and forecast interval.
const six = render([['10:00', 75]], { obsMax: 85.1, obsPrecise: true, obsSource: '6-hour max group' });
assert.equal(label(six), '85.1° precise high');
const guide = six.find(n => n.tag === 'line' && n.attrs['stroke-dasharray']);
assert(guide.attrs.y1 >= 15 && guide.attrs.y1 <= 147);

assert.equal(label(render([['01:00', 60.8]], { obsMax: 60.8, obsPrecise: false })), '60.8° coarse high');
assert.equal(label(render([['01:00', 60.8]], { obsMax: null })), undefined);
assert.equal(label(render([], { obsMax: 57.9, obsPrecise: true }, [['02:00', 61]])), '57.9° precise high');
assert(render([], { obsMax: null }).some(n => n.textContent === 'No observations yet today.'));

// Parse every inline script so edits cannot break dashboard startup.
for (const match of html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/g)) new vm.Script(match[1]);
console.log('Day chart regression checks passed.');
