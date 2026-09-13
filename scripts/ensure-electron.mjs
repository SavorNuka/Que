#!/usr/bin/env node
/**
 * Makes sure Electron's binary is actually on disk before anything tries to run it.
 *
 * Electron >= 42 REMOVED its `postinstall` script (electron/electron#49328).
 * The binary now downloads lazily on `npx electron`, or explicitly via the
 * `install-electron` bin. Tools that resolve the executable path directly —
 * electron-vite among them — never trigger that lazy path, so a fresh
 * `npm install` leaves you with:
 *
 *     Error: Electron uninstall
 *       at getElectronPath (.../electron-vite/dist/chunks/lib-*.js)
 *
 * which is an unhelpful way of saying "node_modules/electron/dist is missing".
 * This script detects that and runs the downloader itself.
 *
 * Flags:
 *   --soft-fail   exit 0 even if the download fails (used by postinstall, so an
 *                 offline install still completes; `npm run dev` will retry)
 *   --check       report status and exit; never download
 */

import { existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const electronDir = join(root, 'node_modules', 'electron');
const installer = join(electronDir, 'install.js');
const args = new Set(process.argv.slice(2));

function installed() {
  // path.txt is written by install.js and names the executable inside dist/.
  return existsSync(join(electronDir, 'path.txt')) && existsSync(join(electronDir, 'dist'));
}

if (!existsSync(electronDir)) {
  console.error('electron is not installed at all — run "npm install" first.');
  process.exit(args.has('--soft-fail') ? 0 : 1);
}

if (installed()) {
  if (args.has('--check')) console.log('Electron binary present.');
  process.exit(0);
}

if (args.has('--check')) {
  console.error('Electron binary MISSING — run "npm run fetch:electron".');
  process.exit(1);
}

console.log('Electron binary missing (it no longer downloads on install) — fetching it now…');

const result = spawnSync(process.execPath, [installer], { stdio: 'inherit', cwd: root });

if (result.status === 0 && installed()) {
  console.log('Electron binary ready.');
  process.exit(0);
}

console.error(
  '\nCould not download the Electron binary.\n' +
    'Run "npx install-electron" manually, or check your network/proxy.\n' +
    'Behind a proxy, set ELECTRON_GET_USE_PROXY=1 and HTTPS_PROXY.\n'
);
process.exit(args.has('--soft-fail') ? 0 : 1);
