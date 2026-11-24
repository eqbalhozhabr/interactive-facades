// Extracts the clickable unit shapes of a project into projects/<id>/units.json:
//   { viewBox: [w, h], views: { "1": [{ id, d }] } }
// <polygon>, <rect> and <path> shapes are converted to path data, so the engine only deals with paths.
//
// Two inputs are supported:
//   node tools/extract-units.mjs <projectId> <legacy index.html>        legacy page: <svg class="interactive-layer" viewBox>
//                                                                        with a <g id="view-N-units"> per view
//   node tools/extract-units.mjs <projectId> <folder | view-1.svg ...>  one SVG per view, named view-N.svg (or View3.svg ...),
//                                                                        shapes directly in the SVG (groups are fine)
// Options: --out <file>   write somewhere else (default projects/<id>/units.json)
//
// Rules for SVG files: every unit shape has an id (the sheet's id column, lower case, e.g. cca-2-204);
// all files share the same viewBox; shapes must not use `transform` (it is ignored, with a warning);
// circle / ellipse / line / polyline are not supported (they are reported). Duplicate ids inside a view are reported.
import { readFile, readdir, stat, writeFile } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const args = process.argv.slice(2);
const outIdx = args.indexOf('--out');
const outArg = outIdx >= 0 ? args.splice(outIdx, 2)[1] : null;
const [id, ...inputs] = args;
if (!id || !inputs.length) {
  console.error('usage: node tools/extract-units.mjs <projectId> <legacy index.html | folder | view-N.svg ...> [--out file]');
  process.exit(1);
}

const attr = (src, name) => (src.match(new RegExp(`\\s${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)')`)) ?? []).slice(1).find((v) => v !== undefined);
const round = (n) => Math.round(Number(n) * 100) / 100;

const pointsToPath = (points) => {
  const n = points.trim().split(/[\s,]+/).filter(Boolean).map(round);
  const pairs = [];
  for (let i = 0; i + 1 < n.length; i += 2) pairs.push(`${n[i]} ${n[i + 1]}`);
  return pairs.length ? `M${pairs.join('L')}Z` : '';
};

const rectToPath = (a) => {
  const [x, y, w, h] = ['x', 'y', 'width', 'height'].map((k) => Number(attr(a, k) ?? 0));
  return `M${round(x)} ${round(y)}H${round(x + w)}V${round(y + h)}H${round(x)}Z`;
};

// Shapes inside one chunk of markup -> [{ id, d }], reporting what could not be used.
function shapesOf(markup, where) {
  const list = [];
  const seen = new Set();
  for (const el of markup.matchAll(/<(polygon|path|rect)\b([^>]*?)\/?>/g)) {
    const [, tag, attrs] = el;
    const unitId = attr(attrs, 'id');
    if (!unitId) { console.warn(`warning: ${where}: a <${tag}> has no id, skipped`); continue; }
    if (attr(attrs, 'transform')) console.warn(`warning: ${where}: ${unitId} has a transform, which is ignored`);
    const d = tag === 'polygon' ? pointsToPath(attr(attrs, 'points') ?? '')
      : tag === 'rect' ? rectToPath(attrs)
      : attr(attrs, 'd')?.replace(/\s+/g, ' ').trim();
    if (!d) { console.warn(`warning: ${where}: ${unitId} has no usable geometry, skipped`); continue; }
    if (seen.has(unitId)) console.warn(`warning: ${where}: duplicate id ${unitId}`);
    seen.add(unitId);
    list.push({ id: unitId, d });
  }
  for (const el of markup.matchAll(/<(circle|ellipse|line|polyline)\b([^>]*?)\/?>/g)) {
    console.warn(`warning: ${where}: unsupported <${el[1]}>${attr(el[2], 'id') ? ` (${attr(el[2], 'id')})` : ''} skipped, convert it to a polygon or path`);
  }
  return list;
}

const viewBoxOf = (svgTag) => {
  const vb = attr(svgTag, 'viewBox');
  if (!vb) return null;
  const n = vb.trim().split(/[\s,]+/).map(Number);
  return n.length === 4 && n.every(Number.isFinite) ? n.slice(2) : null;
};

let viewBox = null;
const views = {};

const first = inputs[0];
const info = await stat(first);
const isHtml = !info.isDirectory() && /\.html?$/i.test(first);

if (isHtml) {
  const html = await readFile(first, 'utf8');
  const tag = html.match(/<svg\b[^>]*class="interactive-layer"[^>]*>/)?.[0];
  viewBox = tag && viewBoxOf(tag);
  if (!viewBox) throw new Error('interactive-layer svg with a viewBox not found');
  for (const g of html.matchAll(/<g id="view-(\d+)-units"[^>]*>([\s\S]*?)<\/g>/g)) {
    views[g[1]] = shapesOf(g[2], `view ${g[1]}`);
  }
} else {
  let files = inputs;
  if (info.isDirectory()) files = (await readdir(first)).filter((f) => /\.svg$/i.test(f)).map((f) => join(first, f));
  for (const file of files.sort()) {
    const n = /view[-_ ]?(\d+)\.svg$/i.exec(basename(file))?.[1];
    if (!n) { console.warn(`skip ${basename(file)}: name must look like view-1.svg`); continue; }
    const svg = await readFile(file, 'utf8');
    const tag = svg.match(/<svg\b[^>]*>/)?.[0];
    const vb = tag && viewBoxOf(tag);
    if (!vb) throw new Error(`${basename(file)}: <svg> has no viewBox`);
    if (viewBox && (vb[0] !== viewBox[0] || vb[1] !== viewBox[1])) {
      throw new Error(`${basename(file)}: viewBox ${vb.join('x')} differs from ${viewBox.join('x')}; all views must share one size`);
    }
    viewBox = vb;
    views[Number(n)] = shapesOf(svg, `view ${Number(n)}`);
  }
}
if (!Object.keys(views).length) throw new Error('no views found');

// A unit may appear in several views (different sides of the building), but the same id twice in one view is a mistake (reported above).
const out = outArg ?? join(dirname(fileURLToPath(import.meta.url)), '..', 'projects', id, 'units.json');
await writeFile(out, JSON.stringify({ viewBox, views }));
const counts = Object.entries(views).map(([v, l]) => `view ${v}: ${l.length}`).join(', ');
console.log(`${id}: viewBox ${viewBox.join('x')}, ${counts} -> ${out}`);
