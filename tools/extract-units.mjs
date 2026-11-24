// Extracts the clickable unit shapes from a legacy facade index.html into units.json.
//   node tools/extract-units.mjs <projectId> <path/to/legacy/index.html>
// Output: projects/<projectId>/units.json  ->  { viewBox: [w, h], views: { "1": [{ id, d }] } }
// <polygon points="..."> and <rect> shapes are converted to path data so the engine only deals with paths.
import { readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const [id, htmlPath] = process.argv.slice(2);
if (!id || !htmlPath) {
  console.error('usage: node tools/extract-units.mjs <projectId> <legacy index.html>');
  process.exit(1);
}

const html = await readFile(htmlPath, 'utf8');

const vb = html.match(/<svg[^>]*class="interactive-layer"[^>]*viewBox="([\d.\s-]+)"/);
if (!vb) throw new Error('interactive-layer svg with a viewBox not found');
const viewBox = vb[1].trim().split(/\s+/).map(Number).slice(2);

const attr = (src, name) => src.match(new RegExp(`\\s${name}="([^"]*)"`))?.[1];
const round = (n) => Math.round(Number(n) * 100) / 100;

const pointsToPath = (points) => {
  const n = points.trim().split(/[\s,]+/).map(round);
  const pairs = [];
  for (let i = 0; i < n.length; i += 2) pairs.push(`${n[i]} ${n[i + 1]}`);
  return `M${pairs.join('L')}Z`;
};

const rectToPath = (a) => {
  const [x, y, w, h] = ['x', 'y', 'width', 'height'].map((k) => Number(attr(a, k) ?? 0));
  return `M${round(x)} ${round(y)}H${round(x + w)}V${round(y + h)}H${round(x)}Z`;
};

const views = {};
for (const g of html.matchAll(/<g id="view-(\d+)-units"[^>]*>([\s\S]*?)<\/g>/g)) {
  const list = [];
  for (const el of g[2].matchAll(/<(polygon|path|rect)\b([^>]*?)\/?>/g)) {
    const [, tag, attrs] = el;
    if (attr(attrs, 'transform')) console.warn(`warning: ${attr(attrs, 'id')} has a transform, which is ignored`);
    const unitId = attr(attrs, 'id');
    const d = tag === 'polygon' ? pointsToPath(attr(attrs, 'points') ?? '')
      : tag === 'rect' ? rectToPath(attrs)
      : attr(attrs, 'd');
    if (unitId && d) list.push({ id: unitId, d });
  }
  views[g[1]] = list;
}

const out = join(dirname(fileURLToPath(import.meta.url)), '..', 'projects', id, 'units.json');
await writeFile(out, JSON.stringify({ viewBox, views }));
const counts = Object.entries(views).map(([v, l]) => `view ${v}: ${l.length}`).join(', ');
console.log(`${id}: viewBox ${viewBox.join('x')}, ${counts} -> ${out}`);
