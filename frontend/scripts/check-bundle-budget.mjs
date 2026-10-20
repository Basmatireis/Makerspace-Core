import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import process from 'node:process';
import { gzipSync } from 'node:zlib';

const directory = resolve(process.argv[2] ?? 'dist');
const manifest = JSON.parse(readFileSync(resolve(directory, '.vite/manifest.json'), 'utf8'));

// One budget per HTML entry: the application and the standalone signage player (docs/signage.md, "Player app").
const budgets = {
  'index.html': { label: 'Application', javascript: 225_000, css: 80_000 },
  'player.html': { label: 'Player', javascript: 90_000, css: 20_000 },
};
const entries = Object.keys(manifest).filter((key) => manifest[key].isEntry);
if (entries.length === 0) throw new Error('Build manifest contains no entry points.');
for (const required of Object.keys(budgets)) {
  if (!entries.includes(required)) throw new Error(`Build manifest has no ${required} entry.`);
}

function graphOf(entry) {
  const visited = new Set();
  const visit = (key) => {
    if (visited.has(key)) return;
    if (!manifest[key]) throw new Error(`Missing static import in build manifest: ${key}`);
    visited.add(key);
    for (const dependency of manifest[key].imports ?? []) visit(dependency);
  };
  visit(entry);
  return visited;
}

const compressedSize = (files) => [...files].reduce(
  (sum, file) => sum + gzipSync(readFileSync(resolve(directory, file))).length,
  0,
);

const failures = [];
for (const entry of entries) {
  const budget = budgets[entry];
  if (!budget) throw new Error(`Entry ${entry} has no bundle budget. Add one to scripts/check-bundle-budget.mjs.`);
  const visited = graphOf(entry);
  const javascript = new Set([...visited].map((key) => manifest[key].file).filter((file) => file.endsWith('.js')));
  const stylesheets = new Set([...visited].flatMap((key) => manifest[key].css ?? []));
  const javascriptBytes = compressedSize(javascript);
  const cssBytes = compressedSize(stylesheets);
  process.stdout.write(`${budget.label} initial static JavaScript: ${javascriptBytes} / ${budget.javascript} gzip bytes (${javascript.size} files)\n`);
  process.stdout.write(`${budget.label} initial CSS: ${cssBytes} / ${budget.css} gzip bytes (${stylesheets.size} files)\n`);
  if ([...visited].some((key) => key === 'src/app/charting.ts' || manifest[key].name === 'charting')) {
    throw new Error('Carbon Charts must remain outside the initial static import graph.');
  }
  if (javascriptBytes > budget.javascript || cssBytes > budget.css) failures.push(budget.label);
}
if (failures.length > 0) {
  throw new Error(`Production loading budget exceeded for: ${failures.join(', ')}. Inspect static dependencies and styles before accepting this build.`);
}
