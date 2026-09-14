import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { interpretProbe } from '../src/main/library/probe';
import { cleanup, ffprobeBin, hasFfmpeg, makeMkv, makeMp3, makeMp4, tempDir } from './helpers/media';

/**
 * The interpretation rules are pure and tested with fixtures; the rules that
 * matter are then confirmed against files ffmpeg actually produced, because
 * this is precisely where reasoning from memory went wrong in the design phase.
 */

const h264aac = (formatName: string) => ({
  streams: [
    { codec_type: 'video', codec_name: 'h264', width: 1920, height: 1080 },
    { codec_type: 'audio', codec_name: 'aac' },
  ],
  format: { format_name: formatName, duration: '5460.25' },
});

describe('interpretProbe', () => {
  it('accepts H.264 + AAC in MP4', () => {
    const r = interpretProbe(h264aac('mov,mp4,m4a,3gp,3g2,mj2'), '.mp4');
    expect(r.needsRemux).toBe(false);
    expect(r.remuxReason).toBeNull();
    expect(r.durationMs).toBe(5_460_250);
    expect(r.width).toBe(1920);
    expect(r.height).toBe(1080);
  });

  /**
   * The finding that reshaped the playback design: Chromium has no Matroska
   * demuxer, so an MKV needs remuxing even when its streams are fine.
   */
  it('rejects the MKV container even with playable streams', () => {
    const r = interpretProbe(h264aac('matroska,webm'), '.mkv');
    expect(r.needsRemux).toBe(true);
    expect(r.remuxReason).toBe('container');
  });

  it('accepts WebM, which shares the same ffprobe format name', () => {
    const r = interpretProbe(
      {
        streams: [
          { codec_type: 'video', codec_name: 'vp9' },
          { codec_type: 'audio', codec_name: 'opus' },
        ],
        format: { format_name: 'matroska,webm', duration: '10' },
      },
      '.webm'
    );
    expect(r.needsRemux).toBe(false);
  });

  it('flags AC-3 audio in an otherwise fine MP4', () => {
    const r = interpretProbe(
      {
        streams: [
          { codec_type: 'video', codec_name: 'h264' },
          { codec_type: 'audio', codec_name: 'ac3' },
        ],
        format: { format_name: 'mov,mp4,m4a,3gp,3g2,mj2', duration: '100' },
      },
      '.mp4'
    );
    expect(r.needsRemux).toBe(true);
    expect(r.remuxReason).toBe('audio-codec');
  });

  it('flags HEVC video', () => {
    const r = interpretProbe(
      {
        streams: [
          { codec_type: 'video', codec_name: 'hevc' },
          { codec_type: 'audio', codec_name: 'aac' },
        ],
        format: { format_name: 'mov,mp4,m4a,3gp,3g2,mj2', duration: '100' },
      },
      '.mp4'
    );
    expect(r.needsRemux).toBe(true);
    expect(r.remuxReason).toBe('video-codec');
  });

  it('reports the container problem first when several apply', () => {
    const r = interpretProbe(
      {
        streams: [
          { codec_type: 'video', codec_name: 'hevc' },
          { codec_type: 'audio', codec_name: 'dts' },
        ],
        format: { format_name: 'avi', duration: '100' },
      },
      '.avi'
    );
    expect(r.remuxReason).toBe('container');
  });

  it('collects tags lower-cased for later metadata use', () => {
    const r = interpretProbe(
      {
        streams: [{ codec_type: 'audio', codec_name: 'flac', tags: { ARTIST: 'Radiohead', ALBUM: 'Kid A' } }],
        format: { format_name: 'flac', duration: '260', tags: { DATE: '2000' } },
      },
      '.flac'
    );
    expect(r.tags['artist']).toBe('Radiohead');
    expect(r.tags['album']).toBe('Kid A');
    expect(r.tags['date']).toBe('2000');
  });

  it('survives a probe with no usable duration', () => {
    const r = interpretProbe({ streams: [], format: { format_name: 'mp3' } }, '.mp3');
    expect(r.durationMs).toBeNull();
    expect(r.videoCodec).toBeNull();
  });
});

describe('probeFile against real media', () => {
  let dir: string;

  beforeEach(() => {
    dir = tempDir('que-probe-');
  });
  afterEach(() => cleanup(dir));

  it.runIf(hasFfmpeg())('reads a real MP4 as directly playable', async () => {
    const { interpretProbe: interpret } = await import('../src/main/library/probe');
    const { execFileSync } = await import('node:child_process');
    const path = makeMp4(dir);
    const json = execFileSync(ffprobeBin(), [
      '-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', '-i', path,
    ]).toString();

    const r = interpret(JSON.parse(json), '.mp4');
    expect(r.videoCodec).toBe('h264');
    expect(r.audioCodec).toBe('aac');
    expect(r.needsRemux).toBe(false);
    expect(r.durationMs).toBeGreaterThan(500);
    expect(r.width).toBe(320);
  });

  it.runIf(hasFfmpeg())('reads a real MKV as needing a container remux', async () => {
    const { interpretProbe: interpret } = await import('../src/main/library/probe');
    const { execFileSync } = await import('node:child_process');
    const path = makeMkv(dir);
    const json = execFileSync(ffprobeBin(), [
      '-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', '-i', path,
    ]).toString();

    const r = interpret(JSON.parse(json), '.mkv');
    // Same codecs as the MP4 above — only the container differs.
    expect(r.videoCodec).toBe('h264');
    expect(r.audioCodec).toBe('aac');
    expect(r.needsRemux).toBe(true);
    expect(r.remuxReason).toBe('container');
  });

  it.runIf(hasFfmpeg())('reads a real MP3 as directly playable', async () => {
    const { interpretProbe: interpret } = await import('../src/main/library/probe');
    const { execFileSync } = await import('node:child_process');
    const path = makeMp3(dir);
    const json = execFileSync(ffprobeBin(), [
      '-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', '-i', path,
    ]).toString();

    const r = interpret(JSON.parse(json), '.mp3');
    expect(r.audioCodec).toBe('mp3');
    expect(r.needsRemux).toBe(false);
  });
});
