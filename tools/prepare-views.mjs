// Converts the still renders of every view to webp:  View1.jpg / view-1.png / ...  ->  assets/view-N.webp
//   node tools/prepare-views.mjs <projectId> --src <dir> [--quality 92] [--width 1920]
// N is the first number in the file name. All views must end up with the same size (it becomes facade.viewBox).
// Target size is roughly 300-700 KB per view; lower --quality if they come out bigger.
import { spawnSync } from 'node:child_process';
import { mkdirSync, readdirSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { findFfmpeg, findFfprobe } from './lib/ffmpeg.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const id = args.find((a, i) => !a.startsWith('--') && !args[i - 1]?.startsWith('--'));
const opt = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : fallback;
};
const src = opt('src');
if (!id || !src) {
  console.error('usage: node tools/prepare-views.mjs <projectId> --src <dir> [--quality 92] [--width 1920]');
  process.exit(1);
}
const quality = opt('quality', '92');
const width = opt('width');

const ffmpeg = findFfmpeg();
const ffprobe = findFfprobe();
const outDir = join(root, 'projects', id, 'assets');
mkdirSync(outDir, { recursive: true });

const sizes = new Set();
let total = 0, count = 0;
for (const file of readdirSync(src).filter((f) => /\.(jpe?g|png|webp)$/i.test(f)).sort()) {
  const n = /(\d+)/.exec(file)?.[1];
  if (!n) { console.warn(`skip ${file}: no view number in the name`); continue; }
  const out = join(outDir, `view-${Number(n)}.webp`);
  const vf = width ? ['-vf', `scale=${width}:-2:flags=lanczos`] : [];
  const r = spawnSync(ffmpeg, ['-y', '-hide_banner', '-loglevel', 'error', '-i', join(src, file), ...vf,
    '-c:v', 'libwebp', '-quality', quality, '-compression_level', '6', '-frames:v', '1', out], { encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`ffmpeg failed on ${file}: ${r.stderr}`);
  const p = spawnSync(ffprobe, ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=width,height', '-of', 'csv=p=0', out], { encoding: 'utf8' });
  const dim = p.stdout.trim().replace(',', 'x');
  sizes.add(dim);
  const bytes = statSync(out).size;
  total += bytes; count++;
  console.log(`${file} -> view-${Number(n)}.webp  ${dim}  ${(bytes / 1024).toFixed(0)} KB`);
}
if (!count) throw new Error(`no images found in ${src}`);
console.log(`${id}: ${count} views, ${(total / 1048576).toFixed(2)} MB total`);
if (sizes.size > 1) console.warn(`WARNING: views have different sizes (${[...sizes].join(', ')}). They must be identical.`);
else console.log(`projects.json -> facade.viewBox: [${[...sizes][0].replace('x', ', ')}]`);
