// Converts a project's sprite-sheet transitions into short H.264 videos.
//   node tools/sprites-to-video.mjs <projectId> [--crf 28] [--gop 4] [--only trans-1-to-2] [--src dir] [--out dir]
// Reads  projects/<id>/assets/sprites/trans-*.webp  (or --src dir; grid of frames, sizes from projects.json)
// Writes projects/<id>/assets/transitions/trans-*.mp4  (same frame count, 30 fps, no audio)
//
// A short GOP keeps seeking cheap, which the viewer relies on for reverse playback and drag-to-rotate.
import { spawnSync } from 'node:child_process';
import { mkdirSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { findFfmpeg } from './lib/ffmpeg.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const id = args.find((a) => !a.startsWith('--'));
const opt = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : fallback;
};
if (!id) {
  console.error('usage: node tools/sprites-to-video.mjs <projectId> [--crf 22] [--gop 4] [--only name] [--out dir]');
  process.exit(1);
}
// crf 28 looked identical to the sprite at 4x zoom (the in-between frames are soft morphs anyway)
// and is roughly 3x smaller than the webp sheet; crf 22 saves almost nothing.
const crf = opt('crf', '28');
const gop = opt('gop', '4');
const only = opt('only');

const { projects } = JSON.parse(readFileSync(join(root, 'projects', 'projects.json'), 'utf8'));
const project = projects.find((p) => p.id === id);
const { frames, sprite } = project?.facade?.transition ?? {};
if (!frames || !sprite) throw new Error(`projects.json needs facade.transition.frames and .sprite for "${id}"`);
const { frameWidth: fw, frameHeight: fh, columns } = sprite;

const srcDir = opt('src') ?? join(root, 'projects', id, 'assets', 'sprites');
const outDir = opt('out') ?? join(root, 'projects', id, 'assets', 'transitions');
mkdirSync(outDir, { recursive: true });
const ffmpeg = findFfmpeg();

// Decode the sheet once, repeat it N times, and let crop pick cell n for frame n (x/y are evaluated per frame).
const vf = [
  `loop=loop=${frames - 1}:size=1:start=0`,
  `setpts=N/(30*TB)`,
  `crop=${fw}:${fh}:'mod(n,${columns})*${fw}':'floor(n/${columns})*${fh}'`,
  'format=yuv420p',
].join(',');

let total = 0;
for (const file of readdirSync(srcDir).filter((f) => /^trans-.*\.webp$/.test(f)).sort()) {
  const name = file.replace(/\.webp$/, '');
  if (only && only !== name) continue;
  const out = join(outDir, `${name}.mp4`);
  const r = spawnSync(ffmpeg, [
    '-y', '-hide_banner', '-loglevel', 'error',
    '-framerate', '30', '-i', join(srcDir, file),
    '-vf', vf, '-frames:v', String(frames),
    '-r', '30', '-c:v', 'libx264', '-preset', 'slow', '-crf', crf,
    '-g', gop, '-bf', '0', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', '-an', out,
  ], { stdio: ['ignore', 'inherit', 'inherit'] });
  if (r.status !== 0) throw new Error(`ffmpeg failed on ${file}`);
  const before = statSync(join(srcDir, file)).size, after = statSync(out).size;
  total += after;
  console.log(`${name}: ${(before / 1048576).toFixed(1)} MB webp -> ${(after / 1048576).toFixed(2)} MB mp4`);
}
console.log(`${id}: ${(total / 1048576).toFixed(2)} MB of video (crf ${crf}, gop ${gop})`);
