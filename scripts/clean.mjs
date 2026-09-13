#!/usr/bin/env node
import { rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const all = process.argv.includes('--all');

const targets = ['out', 'dist', 'node_modules/.vite', ...(all ? ['node_modules'] : [])];

for (const t of targets) {
  rmSync(join(root, t), { recursive: true, force: true });
  console.log(`removed ${t}`);
}
if (all) console.log('\nRun "npm install" next.');
