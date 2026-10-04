import { Injectable } from '@nestjs/common';
import { spawn } from 'node:child_process';
import type { VideoMetadata } from './entities/video.entity';

// FFmpeg is spawned directly as a child process (per phase-03-videos/TD-07) —
// a transcode or a probe against a corrupt/huge file can hang, so every
// invocation is bounded by a timeout that kills the process rather than
// leaving the worker's event loop waiting indefinitely.
const PROBE_TIMEOUT_MS = 30_000;
const THUMBNAIL_TIMEOUT_MS = 60_000;
const THUMBNAIL_WIDTH = 1280;

export interface ProbedVideo {
  durationSeconds: number;
  metadata: VideoMetadata;
}

interface FfprobeStream {
  codec_type: string;
  codec_name?: string;
  width?: number;
  height?: number;
  r_frame_rate?: string;
}

interface FfprobeOutput {
  streams: FfprobeStream[];
  format: {
    format_name: string;
    duration?: string;
    size?: string;
    bit_rate?: string;
  };
}

function runProcess(
  binary: string,
  args: string[],
  timeoutMs: number,
): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(binary, args);
    let stdout = '';
    let stderr = '';

    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`${binary} timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString();
    });
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString();
    });

    child.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });

    child.on('close', (code) => {
      clearTimeout(timer);
      if (code !== 0) {
        reject(new Error(`${binary} exited with code ${code}: ${stderr}`));
        return;
      }
      resolve(stdout);
    });
  });
}

function parseFrameRate(rFrameRate: string | undefined): number {
  if (!rFrameRate) return 0;
  const [numerator, denominator] = rFrameRate.split('/').map(Number);
  if (!denominator) return 0;
  return Math.round(numerator / denominator);
}

@Injectable()
export class FfmpegService {
  async probe(sourceUrl: string): Promise<ProbedVideo> {
    const stdout = await runProcess(
      'ffprobe',
      [
        '-v',
        'error',
        '-print_format',
        'json',
        '-show_format',
        '-show_streams',
        sourceUrl,
      ],
      PROBE_TIMEOUT_MS,
    );

    const parsed = JSON.parse(stdout) as FfprobeOutput;
    const videoStream = parsed.streams.find((s) => s.codec_type === 'video');
    const audioStream = parsed.streams.find((s) => s.codec_type === 'audio');

    if (!videoStream) {
      throw new Error('No video stream found in the probed file');
    }

    return {
      durationSeconds: Math.round(parseFloat(parsed.format.duration ?? '0')),
      metadata: {
        width: videoStream.width ?? 0,
        height: videoStream.height ?? 0,
        video_codec: videoStream.codec_name ?? '',
        audio_codec: audioStream?.codec_name ?? '',
        container: parsed.format.format_name,
        bitrate: parseInt(parsed.format.bit_rate ?? '0', 10),
        framerate: parseFrameRate(videoStream.r_frame_rate),
        size_bytes: parseInt(parsed.format.size ?? '0', 10),
      },
    };
  }

  async generateThumbnail(
    sourceUrl: string,
    outputPath: string,
  ): Promise<void> {
    await runProcess(
      'ffmpeg',
      [
        '-y',
        '-i',
        sourceUrl,
        '-vf',
        `thumbnail,scale=${THUMBNAIL_WIDTH}:-1`,
        '-frames:v',
        '1',
        outputPath,
      ],
      THUMBNAIL_TIMEOUT_MS,
    );
  }
}
