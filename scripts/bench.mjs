/**
 * Cross-platform launcher for the cold-scan benchmark.
 *
 * The obvious `"bench": "QUE_BENCH=1 vitest run tests/bench"` is POSIX-only.
 * npm runs scripts through cmd.exe on Windows, which has no `VAR=value command`
 * syntax, so it fails with "'QUE_BENCH' is not recognized" — on the only
 * machine the benchmark is actually meant to measure.
 *
 * A wrapper rather than a `cross-env` dependency: this repo already keeps its
 * platform glue in scripts/*.mjs, and one spawn does not justify a package.
 *
 *   npm run bench
 *   npm run bench -- --files 500             (or QUE_BENCH_FILES)
 *   npm run bench -- --sizes 1,2,4,8,16,32   (or QUE_BENCH_SIZES)
 *   npm run bench -- --dir "D:\Movies"       (or QUE_BENCH_DIR)
 *
 * --dir measures a real library instead of generated clips: better evidence,
 * and it needs only ffprobe because nothing is generated. The folder is read
 * only — the scan writes to a throwaway in-memory database and never touches
 * the media.
 */

import { spawnSync } from 'node:child_process';

const argv = process.argv.slice(2);

/** `--files 500` → QUE_BENCH_FILES=500, so neither spelling is a trap. */
function take(flag, envName) {
  const i = argv.indexOf(flag);
  if (i !== -1 && argv[i + 1]) return { [envName]: argv[i + 1] };
  return {};
}

const result = spawnSync('npx', ['vitest', 'run', 'tests/bench'], {
  stdio: 'inherit',
  // shell: true on Windows so `npx` resolves npx.cmd.
  shell: process.platform === 'win32',
  env: {
    ...process.env,
    QUE_BENCH: '1',
    ...take('--files', 'QUE_BENCH_FILES'),
    ...take('--sizes', 'QUE_BENCH_SIZES'),
    ...take('--dir', 'QUE_BENCH_DIR'),
  },
});

if (result.error) {
  console.error(`Could not start vitest: ${result.error.message}`);
  process.exit(1);
}

process.exit(result.status ?? 1);
