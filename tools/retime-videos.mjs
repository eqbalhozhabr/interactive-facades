// Turns long transition videos (any length/fps) into short, viewer-ready clips.
//   node tools/retime-videos.mjs <projectId> --src <dir> [--frames 41] [--fps 34] [--crf 28] [--gop 4] [--size 1920x1080]
//
// Reads  <dir>/*.mp4  whose names contain "<N>_to_<M>" or "<N>-to-<M>" (e.g. Cavalli_clean_01_to_02.mp4)
// Writes projects/<id>/assets/transitions/trans-N-to-M.mp4
//
// How it shortens a clip: it keeps `--frames` frames picked at evenly spaced positions of the source,
// ALWAYS including the first and the last source frame (they must match view-N / view-M, otherwise the
// swap to the still image jumps), then plays them at `--fps`. Duration = (frames - 1) / fps.
// Tip: choose frames so that (sourceFrames - 1) / (frames - 1) is close to a whole number; then almost all
// steps are the same size and the motion stays smooth (122 source frames -> 41 frames = 3.025 per step).
//
// After encoding it compares the first/last output frame with assets/view-N.webp and warns when they differ.
// Put these numbers into projects.json:  facade.transition = { frames, fps }
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, statSync } from 'node:fs';
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
  console.error('usage: node tools/retime-videos.mjs <projectId> --src <dir> [--frames 41] [--fps 34] [--crf 28] [--gop 4] [--size WxH]');
  process.exit(1);
}
const frames = Number(opt('frames', 41));
const fps = Number(opt('fps', 34));
const crf = opt('crf', '28');
const gop = opt('gop', '4');
const size = opt('size');           // optional downscale, e.g. 1280x720
if (!(frames >= 2) || !(fps > 0)) throw new Error('--frames must be >= 2 and --fps > 0');

const ffmpeg = findFfmpeg();
const ffprobe = findFfprobe();
const outDir = join(root, 'projects', id, 'assets', 'transitions');
const assets = join(root, 'projects', id, 'assets');
mkdirSync(outDir, { recursive: true });

const run = (cmd, a) => spawnSync(cmd, a, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });

// Exact frame count: decode-free probe of the packets is not reliable for every file, so count with -count_frames.
function sourceInfo(file) {
  const r = run(ffprobe, ['-v', 'error', '-count_frames', '-select_streams', 'v:0',
    '-show_entries', 'stream=nb_read_frames,width,height,r_frame_rate', '-of', 'json', file]);
  if (r.status !== 0) throw new Error(`ffprobe failed on ${file}: ${r.stderr}`);
  const s = JSON.parse(r.stdout).streams[0];
  return { n: Number(s.nb_read_frames), width: s.width, height: s.height, rate: s.r_frame_rate };
}

// PSNR of one frame of the video against a still, both at the video's size. >= ~30 dB means "same picture".
function psnr(video, frameIndex, still, w, h) {
  const r = run(ffmpeg, ['-hide_banner', '-i', video, '-i', still, '-lavfi',
    `[0:v]select=eq(n\\,${frameIndex}),setpts=PTS-STARTPTS[a];[1:v]scale=${w}:${h}:flags=lanczos,format=yuv420p[b];[a]format=yuv420p[a2];[a2][b]psnr`,
    '-frames:v', '1', '-f', 'null', '-']);
  const m = /average:([\d.]+|inf)/.exec(r.stderr);
  return m ? (m[1] === 'inf' ? 99 : Number(m[1])) : null;
}

const files = readdirSync(src).filter((f) => /\.mp4$/i.test(f)).sort();
let total = 0, done = 0;
for (const file of files) {
  const m = /(\d+)[_-]to[_-](\d+)/i.exec(file);
  if (!m) { console.warn(`skip ${file}: no "<N>_to_<M>" in the name`); continue; }
  const [from, to] = [Number(m[1]), Number(m[2])];
  const input = join(src, file);
  const info = sourceInfo(input);
  if (info.n < frames) throw new Error(`${file}: only ${info.n} source frames, cannot pick ${frames}`);

  const idx = Array.from({ length: frames }, (_, i) => Math.round((i * (info.n - 1)) / (frames - 1)));
  const steps = idx.slice(1).map((v, i) => v - idx[i]);
  const uniq = [...new Set(steps)].sort((a, b) => a - b);
  const expr = idx.map((i) => `eq(n,${i})`).join('+');
  const [w, h] = size ? size.split('x').map(Number) : [info.width, info.height];
  const vf = [`select='${expr}'`, `setpts=N/(${fps}*TB)`, size ? `scale=${w}:${h}:flags=lanczos` : null, 'format=yuv420p'].filter(Boolean).join(',');

  const name = `trans-${from}-to-${to}.mp4`;
  const out = join(outDir, name);
  const r = run(ffmpeg, ['-y', '-hide_banner', '-loglevel', 'error', '-i', input, '-vf', vf,
    '-fps_mode', 'cfr', '-r', String(fps), '-frames:v', String(frames),
    '-c:v', 'libx264', '-preset', 'slow', '-crf', crf, '-g', gop, '-bf', '0',
    '-pix_fmt', 'yuv420p', '-movflags', '+faststart', '-an', out]);
  if (r.status !== 0) throw new Error(`ffmpeg failed on ${file}:\n${r.stderr}`);

  const outInfo = sourceInfo(out);
  if (outInfo.n !== frames) throw new Error(`${name}: expected ${frames} frames, got ${outInfo.n}`);
  const bytes = statSync(out).size;
  total += bytes; done++;

  let check = '';
  const stillFrom = join(assets, `view-${from}.webp`), stillTo = join(assets, `view-${to}.webp`);
  if (existsSync(stillFrom) && existsSync(stillTo)) {
    const a = psnr(out, 0, stillFrom, w, h), b = psnr(out, frames - 1, stillTo, w, h);
    const ok = a >= 28 && b >= 28;
    check = `  ends vs views: ${a?.toFixed(1)} / ${b?.toFixed(1)} dB ${ok ? 'ok' : 'MISMATCH (check that the clip starts/ends on view-' + from + ' / view-' + to + ')'}`;
  } else check = '  (views not in assets yet, ends not checked)';
  console.log(`${name}: ${info.n} -> ${frames} frames, steps ${uniq.join('/')}, ${(bytes / 1048576).toFixed(2)} MB${check}`);
}
if (!done) throw new Error(`no usable videos in ${src}`);
console.log(`${id}: ${done} clips, ${(total / 1048576).toFixed(2)} MB, ${((frames - 1) / fps).toFixed(2)} s each (${size ?? 'source size'})`);
console.log(`projects.json -> facade.transition: { "frames": ${frames}, "fps": ${fps} }`);
