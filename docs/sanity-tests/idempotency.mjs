/**
 * Idempotency + single-flight semantics, demonstrated rather than asserted.
 *
 * Dependency-free. Models a provider call with latency and a call counter, then
 * runs four designs against the same workload so the differences are numbers.
 */

const line = (s = '') => console.log(s);
const pad = (s, n) => String(s).padEnd(n);

// ---------------------------------------------------------------- fake provider

function makeProvider({ latencyMs = 40, failFirst = 0 } = {}) {
  const calls = [];
  let failures = 0;
  return {
    calls,
    async fetch(url) {
      calls.push(url);
      await new Promise((r) => setTimeout(r, latencyMs));
      if (failures < failFirst) {
        failures++;
        throw new Error(`transient 503 for ${url}`);
      }
      // The response is derived from the URL, so a wrong-key hit is detectable.
      return { url, payload: `data-for(${url})` };
    },
  };
}

// ---------------------------------------------------------------- designs

/** A: no protection at all. */
function naive(provider) {
  return (key, url) => provider.fetch(url);
}

/**
 * B: cache only — check, then act.
 * The classic race: N concurrent callers all miss, all execute.
 */
function cacheOnly(provider) {
  const cache = new Map();
  return async (key, url) => {
    if (cache.has(key)) return cache.get(key);
    const result = await provider.fetch(url);
    cache.set(key, result);
    return result;
  };
}

/**
 * C: cache + in-flight map (single-flight).
 * A second caller with the same key joins the first call's promise instead of
 * starting its own. This is what closes the check-then-act window.
 */
function singleFlight(provider) {
  const cache = new Map();
  const inFlight = new Map();

  return async (key, url) => {
    if (cache.has(key)) return cache.get(key);

    const existing = inFlight.get(key);
    if (existing) return existing;

    const promise = provider
      .fetch(url)
      .then((result) => {
        cache.set(key, result);
        return result;
      })
      .finally(() => {
        // Critical: clear on rejection too, or one transient failure poisons
        // the key for the life of the process.
        inFlight.delete(key);
      });

    inFlight.set(key, promise);
    return promise;
  };
}

// ---------------------------------------------------------------- scenarios

async function scenarioConcurrentDuplicates() {
  line('1. Twelve concurrent requests for the SAME resource');
  line('   (a library where twelve tracks share one album)');
  line();
  line(`   ${pad('design', 26)}${pad('provider calls', 16)}all callers correct?`);

  for (const [name, build] of [
    ['naive', naive],
    ['cache, check-then-act', cacheOnly],
    ['cache + single-flight', singleFlight],
  ]) {
    const provider = makeProvider();
    const get = build(provider);
    const results = await Promise.all(
      Array.from({ length: 12 }, () => get('album:kid-a', '/release-group/kid-a'))
    );
    const correct = results.every((r) => r.payload === 'data-for(/release-group/kid-a)');
    line(`   ${pad(name, 26)}${pad(provider.calls.length, 16)}${correct ? 'yes' : 'NO'}`);
  }
  line();
}

async function scenarioKeyPerRow() {
  line('2. Twelve DIFFERENT rows — the key-reuse trap');
  line();

  // Wrong: one key for the whole batch.
  {
    const provider = makeProvider();
    const get = singleFlight(provider);
    const results = await Promise.all(
      Array.from({ length: 12 }, (_, i) =>
        get('scan-batch-2026-09-13', `/recording/track-${i}`)
      )
    );
    const distinct = new Set(results.map((r) => r.payload)).size;
    const correct = results.filter((r, i) => r.payload === `data-for(/recording/track-${i})`).length;
    line(`   one key for the batch      calls=${provider.calls.length}  distinct results=${distinct}  rows correct=${correct}/12`);
  }

  // Right: key grounded in each row's own origin identity.
  {
    const provider = makeProvider();
    const get = singleFlight(provider);
    const results = await Promise.all(
      Array.from({ length: 12 }, (_, i) =>
        get(`musicbrainz:recording:track-${i}`, `/recording/track-${i}`)
      )
    );
    const distinct = new Set(results.map((r) => r.payload)).size;
    const correct = results.filter((r, i) => r.payload === `data-for(/recording/track-${i})`).length;
    line(`   key per row (origin-bound) calls=${provider.calls.length}  distinct results=${distinct}  rows correct=${correct}/12`);
  }
  line();
}

async function scenarioParameterCollision() {
  line('3. Same row, different request parameters');
  line('   (English subtitles, then Spanish, for one film)');
  line();

  // Key omits the parameter that changes the answer.
  {
    const provider = makeProvider();
    const get = singleFlight(provider);
    const en = await get('subs:tt0111161', '/search?id=tt0111161&language=en');
    const es = await get('subs:tt0111161', '/search?id=tt0111161&language=es');
    line(`   key omits language   calls=${provider.calls.length}  spanish request returned: ${es.payload === en.payload ? 'THE ENGLISH RESPONSE' : 'correct'}`);
  }

  // Key includes everything that varies the response.
  {
    const provider = makeProvider();
    const get = singleFlight(provider);
    const en = await get('subs:tt0111161:en', '/search?id=tt0111161&language=en');
    const es = await get('subs:tt0111161:es', '/search?id=tt0111161&language=es');
    line(`   key includes language calls=${provider.calls.length}  spanish request returned: ${es.payload === en.payload ? 'THE ENGLISH RESPONSE' : 'correct'}`);
  }
  line();
}

async function scenarioFailureHandling() {
  line('4. A transient failure must not poison the key');
  line();

  const provider = makeProvider({ failFirst: 1 });
  const get = singleFlight(provider);

  let firstError = null;
  try {
    await get('cinemeta:tt0111161', '/meta/movie/tt0111161');
  } catch (e) {
    firstError = e.message;
  }

  // A retry after the failure must be allowed to execute.
  const retry = await get('cinemeta:tt0111161', '/meta/movie/tt0111161');
  line(`   first attempt failed:  ${firstError !== null}`);
  line(`   retry succeeded:       ${retry.payload === 'data-for(/meta/movie/tt0111161)'}`);
  line(`   provider calls:        ${provider.calls.length} (1 failed + 1 retry)`);
  line();
}

async function scenarioRateBudget() {
  line('5. What deduplication buys against a finite rate budget');
  line();

  // A plausible music library: 5,000 tracks across 400 albums, 120 artists.
  const tracks = 5000;
  const albums = 400;
  const artists = 120;

  // Per track: 1 recording lookup. Per album: 1 release lookup + 1 cover art.
  // Naive, each track triggers its album and artist lookups again.
  const naiveCalls = tracks + tracks + tracks;
  const dedupedCalls = tracks + albums + artists;

  const perSecond = 1; // MusicBrainz, per IP, averaged
  const fmt = (n) => `${(n / perSecond / 60).toFixed(0)} min`;

  line(`   library: ${tracks} tracks / ${albums} albums / ${artists} artists`);
  line(`   MusicBrainz limit: ${perSecond} request/second`);
  line();
  line(`   ${pad('', 26)}${pad('calls', 10)}time at the limit`);
  line(`   ${pad('no deduplication', 26)}${pad(naiveCalls, 10)}${fmt(naiveCalls)}`);
  line(`   ${pad('deduplicated', 26)}${pad(dedupedCalls, 10)}${fmt(dedupedCalls)}`);
  line(`   ${pad('saved', 26)}${pad(naiveCalls - dedupedCalls, 10)}${fmt(naiveCalls - dedupedCalls)}`);
  line();
}

async function scenarioConcurrencyVsLimit() {
  line('6. Does concurrency help? Depends entirely on the provider');
  line();

  // A rate limiter that admits one call per interval regardless of pool size.
  async function runWith({ poolSize, minIntervalMs, jobs, jobMs }) {
    let active = 0;
    let last = 0;
    const started = Date.now();
    const queue = [...jobs];

    const worker = async () => {
      while (queue.length) {
        queue.shift();
        if (minIntervalMs > 0) {
          const wait = Math.max(0, last + minIntervalMs - Date.now());
          last = Math.max(Date.now(), last + minIntervalMs);
          if (wait > 0) await new Promise((r) => setTimeout(r, wait));
        }
        active++;
        await new Promise((r) => setTimeout(r, jobMs));
        active--;
      }
    };

    await Promise.all(Array.from({ length: poolSize }, worker));
    void active;
    return Date.now() - started;
  }

  const jobs = Array.from({ length: 24 }, (_, i) => i);

  const localSerial = await runWith({ poolSize: 1, minIntervalMs: 0, jobs, jobMs: 20 });
  const localPool = await runWith({ poolSize: 8, minIntervalMs: 0, jobs, jobMs: 20 });
  const limitedSerial = await runWith({ poolSize: 1, minIntervalMs: 25, jobs, jobMs: 20 });
  const limitedPool = await runWith({ poolSize: 8, minIntervalMs: 25, jobs, jobMs: 20 });

  line(`   ${pad('workload', 34)}${pad('pool 1', 12)}pool 8`);
  line(`   ${pad('local work (ffprobe-like)', 34)}${pad(localSerial + 'ms', 12)}${localPool}ms`);
  line(`   ${pad('rate-limited (MusicBrainz-like)', 34)}${pad(limitedSerial + 'ms', 12)}${limitedPool}ms`);
  line();
}

// ---------------------------------------------------------------- run

line('='.repeat(72));
line('Idempotency and concurrency semantics — measured');
line('='.repeat(72));
line();

await scenarioConcurrentDuplicates();
await scenarioKeyPerRow();
await scenarioParameterCollision();
await scenarioFailureHandling();
await scenarioRateBudget();
await scenarioConcurrencyVsLimit();
