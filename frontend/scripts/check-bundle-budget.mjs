import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import process from 'node:process';
import { gzipSync } from 'node:zlib';

const directory = resolve(process.argv[2] ?? 'dist');
const manifest = JSON.parse(readFileSync(resolve(directory, '.vite/manifest.json'), 'utf8'));
const entries = Object.keys(manifest).filter((key) => manifest[key].isEntry);
if (entries.length === 0) throw new Error('Build manifest contains no entry points.');

const visited = new Set();
function visit(key) {
  if (visited.has(key)) return;
  if (!manifest[key]) throw new Error(`Missing static import in build manifest: ${key}`);
  visited.add(key);
  for (const dependency of manifest[key].imports ?? []) visit(dependency);
}
entries.forEach(visit);

const javascript = new Set([...visited].map((key) => manifest[key].file).filter((file) => file.endsWith('.js')));
const stylesheets = new Set([...visited].flatMap((key) => manifest[key].css ?? []));
const compressedSize = (files) => [...files].reduce(
  (sum, file) => sum + gzipSync(readFileSync(resolve(directory, file))).length,
  0,
);
const javascriptBytes = compressedSize(javascript);
const cssBytes = compressedSize(stylesheets);
process.stdout.write(`Initial static JavaScript: ${javascriptBytes} / 225000 gzip bytes (${javascript.size} files)\n`);
process.stdout.write(`Initial CSS: ${cssBytes} / 80000 gzip bytes (${stylesheets.size} files)\n`);
if ([...visited].some((key) => key === 'src/app/charting.ts' || manifest[key].name === 'charting')) {
  throw new Error('Carbon Charts must remain outside the initial static import graph.');
}
if (javascriptBytes > 225_000 || cssBytes > 80_000) {
  throw new Error('Production loading budget exceeded. Inspect static dependencies and styles before accepting this build.');
}
