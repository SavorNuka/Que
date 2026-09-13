#!/usr/bin/env node
/**
 * Boot smoke test.
 *
 * Builds nothing — run `npm run build` first — then launches the real app with
 * QUE_SMOKE=1 and waits for its verdict. Main does the checking (see
 * runSmokeTest in src/main/index.ts) because the point is to exercise the
 * actual startup path, not a simulation of it.
 *
 * Linux needs a virtual display; xvfb-run is used when present.
 */

import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);

if (!existsSync(join(root, 'out', 'main', 'index.js'))) {
  console.error('No build found — run "npm run build" first.');
  process.exit(1);
}

let electronBin;
try {
  electronBin = require('electron');
} catch {
  console.error('Electron is not installed — run "npm run fetch:electron".');
  process.exit(1);
}

const needsDisplay = process.platform === 'linux' && !process.env.DISPLAY;
const args = ['.', '--no-sandbox'];

const command = needsDisplay ? 'xvfb-run' : electronBin;
const commandArgs = needsDisplay
  ? ['-a', '--server-args=-screen 0 1280x800x24', electronBin, ...args]
  : args;

const child = spawn(command, commandArgs, {
  cwd: root,
  env: { ...process.env, QUE_SMOKE: '1', ELECTRON_DISABLE_SECURITY_WARNINGS: '1' },
  stdio: ['ignore', 'pipe', 'pipe'],
});

let output = '';
const capture = (chunk) => {
  const text = chunk.toString();
  output += text;
  process.stdout.write(text);
};
child.stdout.on('data', capture);
child.stderr.on('data', capture);

const timer = setTimeout(() => {
  console.error('\nSMOKE FAIL: the app did not exit within 60s');
  child.kill('SIGKILL');
  process.exit(1);
}, 60_000);

child.on('exit', (code) => {
  clearTimeout(timer);
  if (code === 0 && output.includes('SMOKE PASS')) {
    process.exit(0);
  }
  console.error(`\nSMOKE FAIL: exit code ${code}`);
  process.exit(1);
});
