// Locates ffmpeg: FFMPEG env var, then PATH, then the winget install folder
// (a fresh winget install is not on PATH until the shell is restarted).
import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export function findFfmpeg() {
  if (process.env.FFMPEG) return process.env.FFMPEG;
  if (spawnSync('ffmpeg', ['-version']).status === 0) return 'ffmpeg';
  const pkgs = join(process.env.LOCALAPPDATA ?? join(homedir(), 'AppData', 'Local'), 'Microsoft', 'WinGet', 'Packages');
  if (existsSync(pkgs)) {
    for (const d of readdirSync(pkgs).filter((n) => n.startsWith('Gyan.FFmpeg'))) {
      for (const v of readdirSync(join(pkgs, d)).filter((n) => n.startsWith('ffmpeg-'))) {
        const exe = join(pkgs, d, v, 'bin', 'ffmpeg.exe');
        if (existsSync(exe)) return exe;
      }
    }
  }
  throw new Error('ffmpeg not found. Install it (winget install Gyan.FFmpeg) or set the FFMPEG env var.');
}
