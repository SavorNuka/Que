import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { ffprobePath } from '../ffmpeg';

const run = promisify(execFile);

/**
 * ffprobe wrapper.
 *
 * Decides, per file, whether Chromium can play it directly — which is the
 * question the whole playback path hangs on (ARCHITECTURE §2.1). The answer is
 * more often "no" than the original design assumed, because Chromium has no
 * Matroska demuxer at all: a plain H.264+AAC .mkv still needs remuxing.
 */

export interface ProbeResult {
  durationMs: number | null;
  container: string | null;
  videoCodec: string | null;
  audioCodec: string | null;
  width: number | null;
  height: number | null;
  needsRemux: boolean;
  remuxReason: RemuxReason | null;
  /** Tags lifted from the container — used for audio metadata in M3. */
  tags: Record<string, string>;
}

export type RemuxReason = 'container' | 'video-codec' | 'audio-codec';

/**
 * Containers Chromium can demux. Everything else needs a container remux even
 * when the streams inside are perfectly playable.
 */
const PLAYABLE_CONTAINERS = new Set(['mov,mp4,m4a,3gp,3g2,mj2', 'matroska,webm', 'ogg', 'wav', 'mp3', 'flac', 'aac']);

/**
 * `matroska,webm` is one ffprobe format covering both. WebM is playable and
 * MKV is not, so the container name alone is ambiguous and the file extension
 * breaks the tie.
 */
const WEBM_EXTENSIONS = new Set(['.webm']);

const PLAYABLE_VIDEO = new Set(['h264', 'vp8', 'vp9', 'av1', 'theora']);
/** HEVC plays only where the platform decodes it; treated as needing help. */
const PLAYABLE_AUDIO = new Set(['aac', 'mp3', 'opus', 'vorbis', 'flac', 'pcm_s16le', 'pcm_s24le', 'pcm_f32le']);

interface FfprobeStream {
  codec_type?: string;
  codec_name?: string;
  width?: number;
  height?: number;
  duration?: string;
  tags?: Record<string, string>;
}

interface FfprobeOutput {
  streams?: FfprobeStream[];
  format?: {
    format_name?: string;
    duration?: string;
    tags?: Record<string, string>;
  };
}

/** Parse ffprobe's JSON into our shape. Pure, so it is testable with fixtures. */
export function interpretProbe(raw: FfprobeOutput, ext: string): ProbeResult {
  const streams = raw.streams ?? [];
  const video = streams.find((s) => s.codec_type === 'video');
  const audio = streams.find((s) => s.codec_type === 'audio');

  const container = raw.format?.format_name ?? null;
  const videoCodec = video?.codec_name ?? null;
  const audioCodec = audio?.codec_name ?? null;

  const seconds = Number(raw.format?.duration ?? video?.duration ?? audio?.duration ?? NaN);
  const durationMs = Number.isFinite(seconds) && seconds > 0 ? Math.round(seconds * 1000) : null;

  // Container first — it disqualifies a file regardless of its streams.
  let needsRemux = false;
  let remuxReason: RemuxReason | null = null;

  const containerPlayable =
    container !== null &&
    PLAYABLE_CONTAINERS.has(container) &&
    // matroska,webm is only playable when it really is WebM.
    (container !== 'matroska,webm' || WEBM_EXTENSIONS.has(ext.toLowerCase()));

  if (!containerPlayable) {
    needsRemux = true;
    remuxReason = 'container';
  } else if (videoCodec !== null && !PLAYABLE_VIDEO.has(videoCodec)) {
    needsRemux = true;
    remuxReason = 'video-codec';
  } else if (audioCodec !== null && !PLAYABLE_AUDIO.has(audioCodec)) {
    needsRemux = true;
    remuxReason = 'audio-codec';
  }

  // Container tags win over stream tags; both are lower-cased for lookup.
  const tags: Record<string, string> = {};
  for (const source of [audio?.tags, video?.tags, raw.format?.tags]) {
    if (!source) continue;
    for (const [k, v] of Object.entries(source)) {
      if (typeof v === 'string') tags[k.toLowerCase()] = v;
    }
  }

  return {
    durationMs,
    container,
    videoCodec,
    audioCodec,
    width: video?.width ?? null,
    height: video?.height ?? null,
    needsRemux,
    remuxReason,
    tags,
  };
}

export class FfprobeUnavailableError extends Error {
  constructor() {
    super('ffprobe is not available — run "npm run fetch:ffmpeg"');
    this.name = 'FfprobeUnavailableError';
  }
}

/**
 * Probe one file.
 *
 * execFile with an argument array, never a shell string, so a filename
 * containing quotes or semicolons is just a filename (ARCHITECTURE §17).
 */
export async function probeFile(path: string, ext: string, timeoutMs = 30_000): Promise<ProbeResult> {
  const bin = ffprobePath();
  if (!bin) throw new FfprobeUnavailableError();

  const { stdout } = await run(
    bin,
    [
      '-v', 'error',
      '-print_format', 'json',
      '-show_format',
      '-show_streams',
      '-i', path,
    ],
    { timeout: timeoutMs, maxBuffer: 8 * 1024 * 1024 }
  );

  return interpretProbe(JSON.parse(stdout) as FfprobeOutput, ext);
}
