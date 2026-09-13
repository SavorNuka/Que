#!/usr/bin/env node
/**
 * Downloads ffmpeg + ffprobe into resources/bin.
 *
 * ARCHITECTURE §2.1: the sidecar is what makes MKV and AC-3 playable, and it
 * also gives duration probing, embedded tag/art extraction and frame grabs.
 *
 * Flags:
 *   --if-missing   do nothing if both binaries are already present
 *   --soft-fail    exit 0 on failure (used by postinstall, so a flaky network
 *                  or an offline install never breaks `npm install`)
 */

import { createWriteStream, existsSync, mkdirSync, rmSync } from 'node:fs';
import { chmod, rename } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const binDir = join(root, 'resources', 'bin');
const args = new Set(process.argv.slice(2));
const softFail = args.has('--soft-fail');
const exe = process.platform === 'win32' ? '.exe' : '';

const SOURCES = {
  win32: {
    url: 'https://www.gyan.dev/ffmpeg/builds/ffmpeg-release-essentials.zip',
    kind: 'zip',
  },
  linux: {
    url: 'https://johnvansickle.com/ffmpeg/releases/ffmpeg-release-amd64-static.tar.xz',
    kind: 'tarxz',
  },
  darwin: null,
};

function have() {
  return existsSync(join(binDir, `ffmpeg${exe}`)) && existsSync(join(binDir, `ffprobe${exe}`));
}

function done(msg) {
  console.log(msg);
  process.exit(0);
}

function fail(msg) {
  console.error(msg);
  process.exit(softFail ? 0 : 1);
}

async function download(url, dest) {
  console.log(`  downloading ${url}`);
  const res = await fetch(url, { redirect: 'follow' });
  if (!res.ok || !res.body) throw new Error(`HTTP ${res.status} for ${url}`);
  await pipeline(Readable.fromWeb(res.body), createWriteStream(dest));
}

/** Extract with whatever the platform already has — no npm archive dependency. */
function extract(archive, into, kind) {
  mkdirSync(into, { recursive: true });
  if (kind === 'zip') {
    if (process.platform === 'win32') {
      execFileSync(
        'powershell',
        [
          '-NoProfile',
          '-NonInteractive',
          '-Command',
          `Expand-Archive -LiteralPath "${archive}" -DestinationPath "${into}" -Force`,
        ],
        { stdio: 'inherit' }
      );
    } else {
      execFileSync('unzip', ['-q', '-o', archive, '-d', into], { stdio: 'inherit' });
    }
  } else {
    execFileSync('tar', ['-xf', archive, '-C', into], { stdio: 'inherit' });
  }
}

/** Recursively find a binary by name inside an extracted tree. */
async function locate(dir, name) {
  const { readdir, stat } = await import('node:fs/promises');
  for (const entry of await readdir(dir)) {
    const p = join(dir, entry);
    const s = await stat(p);
    if (s.isDirectory()) {
      const found = await locate(p, name);
      if (found) return found;
    } else if (entry === name) {
      return p;
    }
  }
  return null;
}

async function main() {
  if (args.has('--if-missing') && have()) done('ffmpeg and ffprobe already present — nothing to do');

  const source = SOURCES[process.platform];
  if (!source) {
    fail(
      `No automatic ffmpeg download configured for ${process.platform}. ` +
        `Install ffmpeg yourself and copy ffmpeg/ffprobe into resources/bin.`
    );
    return;
  }

  mkdirSync(binDir, { recursive: true });
  const work = join(tmpdir(), `que-ffmpeg-${Date.now()}`);
  mkdirSync(work, { recursive: true });
  const archive = join(work, source.kind === 'zip' ? 'ffmpeg.zip' : 'ffmpeg.tar.xz');

  try {
    await download(source.url, archive);
    console.log('  extracting…');
    extract(archive, work, source.kind);

    for (const name of ['ffmpeg', 'ffprobe']) {
      const found = await locate(work, `${name}${exe}`);
      if (!found) throw new Error(`${name}${exe} not found inside the downloaded archive`);
      const dest = join(binDir, `${name}${exe}`);
      await rename(found, dest).catch(async () => {
        const { copyFile } = await import('node:fs/promises');
        await copyFile(found, dest);
      });
      if (process.platform !== 'win32') await chmod(dest, 0o755);
      console.log(`  installed ${dest}`);
    }

    console.log('ffmpeg sidecar ready.');
  } catch (err) {
    fail(
      `Could not fetch ffmpeg: ${err instanceof Error ? err.message : String(err)}\n` +
        `Que still runs — playback is limited to formats Chromium handles natively ` +
        `(no MKV, no AC-3). Re-run "npm run fetch:ffmpeg" when you have a connection.`
    );
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

await main();
