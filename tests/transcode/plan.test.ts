import { execFileSync } from 'node:child_process';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildHlsArgs, needsHls, planTranscode } from '../../src/main/transcode/plan';
import { interpretProbe } from '../../src/main/library/probe';
import {
  cleanup,
  ffprobeBin,
  hasFfmpeg,
  makeAc3Mkv,
  makeHevcMkv,
  makeMp4,
  tempDir,
} from '../helpers/media';

describe('planTranscode', () => {
  it('a direct-play MP4 needs nothing', () => {
    const p = planTranscode('mov,mp4,m4a,3gp,3g2,mj2', 'h264', 'aac', '.mp4');
    expect(p).toEqual({ remuxContainer: false, transcodeVideo: false, transcodeAudio: false });
    expect(needsHls(p)).toBe(false);
  });

  it('MKV with playable streams needs only a container remux', () => {
    const p = planTranscode('matroska,webm', 'h264', 'aac', '.mkv');
    expect(p).toEqual({ remuxContainer: true, transcodeVideo: false, transcodeAudio: false });
  });

  /**
   * R7 — the regression this test exists to catch: a planner that reads only
   * `remux_reason` would report just 'container' for this file (probe.ts
   * checks container first) and a naive implementation would copy the AC-3
   * audio straight into the HLS output, which still won't decode.
   */
  it('MKV + H.264 + AC-3 needs a container remux AND an audio transcode at once', () => {
    const p = planTranscode('matroska,webm', 'h264', 'ac3', '.mkv');
    expect(p.remuxContainer).toBe(true);
    expect(p.transcodeAudio).toBe(true);
    expect(p.transcodeVideo).toBe(false);
  });

  it('HEVC in an otherwise fine MP4 needs only a video transcode', () => {
    const p = planTranscode('mov,mp4,m4a,3gp,3g2,mj2', 'hevc', 'aac', '.mp4');
    expect(p).toEqual({ remuxContainer: false, transcodeVideo: true, transcodeAudio: false });
  });

  it('a file needing all three help paths at once reports all three', () => {
    const p = planTranscode('avi', 'hevc', 'dts', '.avi');
    expect(p).toEqual({ remuxContainer: true, transcodeVideo: true, transcodeAudio: true });
  });
});

describe('buildHlsArgs', () => {
  it('copies both streams when the plan needs only a container remux', () => {
    const args = buildHlsArgs(
      { remuxContainer: true, transcodeVideo: false, transcodeAudio: false },
      { inputPath: 'in.mkv', playlistPath: 'out/playlist.m3u8', segmentPattern: 'out/seg%05d.ts' }
    );
    expect(args).toContain('copy');
    expect(args.filter((a) => a === 'copy')).toHaveLength(2);
    expect(args).not.toContain('libx264');
    expect(args).not.toContain('aac');
  });

  it('always maps exactly the first video and audio stream, never subtitles/attachments', () => {
    const args = buildHlsArgs(
      { remuxContainer: true, transcodeVideo: false, transcodeAudio: false },
      { inputPath: 'in.mkv', playlistPath: 'out/playlist.m3u8', segmentPattern: 'out/seg%05d.ts' }
    );
    expect(args).toEqual(expect.arrayContaining(['-map', '0:v:0', '-map', '0:a:0']));
    expect(args.filter((a) => a === '-map')).toHaveLength(2);
  });

  it('transcodes only the stream the plan flags', () => {
    const args = buildHlsArgs(
      { remuxContainer: true, transcodeVideo: false, transcodeAudio: true },
      { inputPath: 'in.mkv', playlistPath: 'out/playlist.m3u8', segmentPattern: 'out/seg%05d.ts' }
    );
    expect(args).toEqual(expect.arrayContaining(['-c:v', 'copy', '-c:a', 'aac']));
  });

  it('places -ss before -i for a seek, and never emits it for the from-start job', () => {
    const seek = buildHlsArgs(
      { remuxContainer: true, transcodeVideo: false, transcodeAudio: false },
      { inputPath: 'in.mkv', playlistPath: 'p', segmentPattern: 's', startSeconds: 42 }
    );
    expect(seek.indexOf('-ss')).toBeLessThan(seek.indexOf('-i'));

    const fromStart = buildHlsArgs(
      { remuxContainer: true, transcodeVideo: false, transcodeAudio: false },
      { inputPath: 'in.mkv', playlistPath: 'p', segmentPattern: 's', startSeconds: 0 }
    );
    expect(fromStart).not.toContain('-ss');
  });

  it('caps ffmpeg threads only for an actual video transcode, per the shared budget', () => {
    const copyOnly = buildHlsArgs(
      { remuxContainer: true, transcodeVideo: false, transcodeAudio: false },
      { inputPath: 'in.mkv', playlistPath: 'p', segmentPattern: 's', threads: 4 }
    );
    expect(copyOnly).not.toContain('-threads');

    const videoTranscode = buildHlsArgs(
      { remuxContainer: false, transcodeVideo: true, transcodeAudio: false },
      { inputPath: 'in.mp4', playlistPath: 'p', segmentPattern: 's', threads: 4 }
    );
    expect(videoTranscode).toEqual(expect.arrayContaining(['-threads', '4']));
  });

  it('writes an EVENT playlist, the mechanism that makes generation progressive', () => {
    const args = buildHlsArgs(
      { remuxContainer: true, transcodeVideo: false, transcodeAudio: false },
      { inputPath: 'in.mkv', playlistPath: 'p', segmentPattern: 's' }
    );
    expect(args).toEqual(expect.arrayContaining(['-hls_playlist_type', 'event']));
  });

  /**
   * OPEN-ACTIONS #12: found by writing an adversarial test that measured real
   * segment durations instead of trusting `-hls_time`. It is only a minimum —
   * the muxer cuts at the next keyframe after that many seconds — and x264's
   * default keyframe interval (~10s at 24fps) is longer than the default
   * hlsTime of 6, so real segments ran far longer than intended for any
   * actual re-encode. `-force_key_frames` is the fix; a copy-only job needs
   * no such thing, since it cannot control the source's own keyframes.
   */
  it('forces a keyframe every hlsTime seconds when actually re-encoding video', () => {
    const transcode = buildHlsArgs(
      { remuxContainer: false, transcodeVideo: true, transcodeAudio: false },
      { inputPath: 'in.mp4', playlistPath: 'p', segmentPattern: 's', hlsTimeSeconds: 4 }
    );
    expect(transcode).toEqual(expect.arrayContaining(['-force_key_frames', 'expr:gte(t,n_forced*4)']));
  });

  it('never forces keyframes on a copy-only job — nothing controls the source\'s own', () => {
    const copyOnly = buildHlsArgs(
      { remuxContainer: true, transcodeVideo: false, transcodeAudio: true },
      { inputPath: 'in.mkv', playlistPath: 'p', segmentPattern: 's' }
    );
    expect(copyOnly).not.toContain('-force_key_frames');
  });
});

/**
 * Against real ffmpeg output, closing the gap PRA-M1c §3/§8 leaves open: no
 * HEVC or AC-3 sample exists in any real library available to this project.
 * These fixtures are synthesized, not a substitute for a real sample —
 * labelled here exactly as the PRA requires.
 */
describe('planTranscode against real synthesized fixtures', () => {
  let dir: string;

  beforeEach(() => {
    dir = tempDir('que-plan-');
  });
  afterEach(() => cleanup(dir));

  it.runIf(hasFfmpeg())('plans an AC-3-in-MKV fixture as container + audio work, no video work', () => {
    const path = makeAc3Mkv(dir);
    const json = execFileSync(ffprobeBin(), [
      '-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', '-i', path,
    ]).toString();
    const probed = interpretProbe(JSON.parse(json), '.mkv');

    const plan = planTranscode(probed.container, probed.videoCodec, probed.audioCodec, '.mkv');
    expect(plan.remuxContainer).toBe(true);
    expect(plan.transcodeAudio).toBe(true);
    expect(plan.transcodeVideo).toBe(false);
  });

  it.runIf(hasFfmpeg())('plans a HEVC-in-MKV fixture as needing video work — SYNTHETIC, no real sample exists', () => {
    const path = makeHevcMkv(dir);
    const json = execFileSync(ffprobeBin(), [
      '-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', '-i', path,
    ]).toString();
    const probed = interpretProbe(JSON.parse(json), '.mkv');

    expect(probed.videoCodec).toBe('hevc');
    const plan = planTranscode(probed.container, probed.videoCodec, probed.audioCodec, '.mkv');
    expect(plan.transcodeVideo).toBe(true);
  });

  it.runIf(hasFfmpeg())('a direct-play MP4 plans as no work at all', () => {
    const path = makeMp4(dir);
    const json = execFileSync(ffprobeBin(), [
      '-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', '-i', path,
    ]).toString();
    const probed = interpretProbe(JSON.parse(json), '.mp4');

    const plan = planTranscode(probed.container, probed.videoCodec, probed.audioCodec, '.mp4');
    expect(needsHls(plan)).toBe(false);
  });
});
