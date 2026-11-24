// Downloads each project's published Google Sheet (CSV) and writes projects/<id>/data.json.
//   node tools/sync-sheets.mjs            # all projects that have a "sheet" URL in projects.json
//   node tools/sync-sheets.mjs armas      # one project
// Run it whenever the sheet changes; the site then serves static JSON instead of calling Google.
import { readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const { projects } = JSON.parse(await readFile(join(root, 'projects', 'projects.json'), 'utf8'));
const only = process.argv[2];

// RFC 4180 style parser: handles quoted cells, embedded commas/newlines and "" escapes.
function parseCsv(text) {
  const rows = [];
  let row = [], cell = '', quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') { cell += '"'; i++; }
      else if (c === '"') quoted = false;
      else cell += c;
    } else if (c === '"') quoted = true;
    else if (c === ',') { row.push(cell); cell = ''; }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(cell); cell = '';
      if (row.some((v) => v.trim())) rows.push(row);
      row = [];
    } else cell += c;
  }
  row.push(cell);
  if (row.some((v) => v.trim())) rows.push(row);
  return rows;
}

for (const p of projects) {
  if (!p.facade?.sheet || (only && only !== p.id)) continue;
  const res = await fetch(p.facade.sheet);
  if (!res.ok) throw new Error(`${p.id}: sheet request failed (${res.status})`);
  const [header, ...rows] = parseCsv((await res.text()).replace(/^﻿/, ''));
  // Some sheets leave the first header cell empty; that column has always been the unit id.
  if (!header[0].trim()) { header[0] = 'id'; console.warn(`${p.id}: first column has no header, treating it as "id"`); }
  const col = Object.fromEntries(header.map((h, i) => [h.trim(), i]));
  for (const need of ['id', 'type', 'unitNumber', 'floor', 'area', 'status', 'planImg', 'tourLink']) {
    if (!(need in col)) throw new Error(`${p.id}: sheet is missing the "${need}" column`);
  }
  const data = {};
  for (const r of rows) {
    const get = (k) => (r[col[k]] ?? '').trim();
    const id = get('id').toLowerCase();
    if (!id) continue;
    const tour = get('tourLink');
    data[id] = {
      type: get('type') || '-',
      unitNumber: get('unitNumber') || '-',
      floor: get('floor') || '-',
      area: get('area') || '-',
      status: get('status') || 'Unknown',
      planImg: get('planImg').replace(/\\/g, '/'),
      tourLink: tour && tour !== '#' ? tour : '',
    };
  }
  await writeFile(join(root, 'projects', p.id, 'data.json'), JSON.stringify(data));
  console.log(`${p.id}: ${Object.keys(data).length} units`);
}
