import { PLAYABLE_AUDIO, PLAYABLE_VIDEO, isContainerPlayable } from '../library/probe';

/**
 * Per-stream transcode planning (PRA-M1c §5.1).
 *
 * `needs_remux`/`remux_reason` (probe.ts) is a single enum — a file gets
 * exactly one reason, even when more than one is true. ARCHITECTURE §2.1's
 * own worked example, MKV + H.264 + AC-3, needs a container remux AND an
 * audio transcode at the same time; a planner that branched on the single
 * reason would fix only one and still not play. This computes all three
 * independently from the raw container/codec values, which is free — those
 * columns already exist on `media` (PRA-M1c §4 C1 / R7).
 */

export interface TranscodePlan {
  remuxContainer: boolean;
  transcodeVideo: boolean;
  transcodeAudio: boolean;
}

export function planTranscode(
  container: string | null,
  videoCodec: string | null,
  audioCodec: string | null,
  ext: string
): TranscodePlan {
  return {
    remuxContainer: !isContainerPlayable(container, ext),
    transcodeVideo: videoCodec !== null && !PLAYABLE_VIDEO.has(videoCodec),
    transcodeAudio: audioCodec !== null && !PLAYABLE_AUDIO.has(audioCodec),
  };
}

export function needsHls(plan: TranscodePlan): boolean {
  return plan.remuxContainer || plan.transcodeVideo || plan.transcodeAudio;
}

export interface HlsArgsOptions {
  inputPath: string;
  playlistPath: string;
  /** ffmpeg's own `%05d`-style pattern, an absolute path. */
  segmentPattern: string;
  /** Seconds into the file to start at — a seek beyond the original frontier. */
  startSeconds?: number;
  hlsTimeSeconds?: number;
  /** Caps libx264's own thread count — see the shared concurrency budget (§5.4). */
  threads?: number;
}

/**
 * ffmpeg arguments for one progressive HLS generation job.
 *
 * `-map 0:v:0 -map 0:a:0` is mandatory, not cosmetic: real files commonly
 * carry subtitle and font-attachment streams (PRA-M1c §3 M-4) that the HLS
 * muxer cannot pass through, and an unqualified `-map 0` fails on them.
 *
 * `-hls_playlist_type event` is what makes this "progressive" rather than
 * "wait for the whole file": ffmpeg appends to the playlist as each segment
 * closes and writes `#EXT-X-ENDLIST` only on a clean exit. The server serves
 * whatever the file currently contains — hls.js polls a playlist with no
 * ENDLIST and stops once it sees one. No separate "is it ready" signal is
 * needed; the growing file IS the signal (§5.2).
 */
export function buildHlsArgs(plan: TranscodePlan, opts: HlsArgsOptions): string[] {
  const args: string[] = ['-y', '-v', 'error'];

  if (opts.startSeconds !== undefined && opts.startSeconds > 0) {
    // Before -i: fast, keyframe-aligned seek. Good enough to resume near the
    // requested point — this is a compatibility fallback, not frame-accurate
    // scrubbing, and it is free on a stream-copy job.
    args.push('-ss', opts.startSeconds.toFixed(3));
  }

  args.push('-i', opts.inputPath, '-map', '0:v:0', '-map', '0:a:0');

  const hlsTime = opts.hlsTimeSeconds ?? 6;

  args.push('-c:v', plan.transcodeVideo ? 'libx264' : 'copy');
  if (plan.transcodeVideo) {
    args.push('-preset', 'veryfast', '-crf', '20');
    if (opts.threads !== undefined) args.push('-threads', String(opts.threads));
    /**
     * `-hls_time` is only a minimum: the HLS muxer cuts at the next
     * keyframe *after* that many seconds, and x264's default keyframe
     * interval (~250 frames, ~10s at 24fps) is longer than the default
     * `hlsTime` of 6 — found by writing an adversarial test that measured
     * real segment durations rather than trusting the flag (OPEN-ACTIONS
     * #12). Left unset, real segments run far longer than `hlsTime`, which
     * both delays time-to-first-segment and breaks the seek bucketing in
     * `cache.ts`/`Player.tsx`, which assumes segments are actually this
     * length. `expr:gte(...)` forces one every `hlsTime` seconds of
     * presentation time regardless of the source's frame rate. Only
     * meaningful for an actual re-encode — a copy-only job inherits
     * whatever keyframes the source already has.
     */
    args.push('-force_key_frames', `expr:gte(t,n_forced*${String(hlsTime)})`);
  }

  args.push('-c:a', plan.transcodeAudio ? 'aac' : 'copy');
  if (plan.transcodeAudio) args.push('-b:a', '192k');

  args.push(
    '-f', 'hls',
    '-hls_time', String(hlsTime),
    '-hls_playlist_type', 'event',
    '-hls_segment_filename', opts.segmentPattern,
    opts.playlistPath
  );

  return args;
}
