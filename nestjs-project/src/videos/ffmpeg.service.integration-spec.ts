import { spawn } from 'node:child_process';
import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { FfmpegService } from './ffmpeg.service';

// No binary fixture is committed to the repo. A short synthetic video is
// generated with the same ffmpeg binary this service invokes in production
// (black 1s + a colorful "testsrc" pattern 1s, h264/aac/mp4) — this also
// lets the thumbnail-selection test assert the real first frame is black
// without depending on an opaque, hard-to-audit binary file in git.
function run(binary: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(binary, args);
    let stderr = '';
    child.stderr.on('data', (d: Buffer) => (stderr += d.toString()));
    child.on('close', (code) =>
      code === 0 ? resolve() : reject(new Error(stderr)),
    );
  });
}

describe('FfmpegService (integration — real binaries)', () => {
  let fixturePath: string;
  let fixtureDir: string;
  const service = new FfmpegService();

  beforeAll(async () => {
    fixtureDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ffmpeg-fixture-'));
    fixturePath = path.join(fixtureDir, 'fixture.mp4');

    await run('ffmpeg', [
      '-y',
      '-f',
      'lavfi',
      '-i',
      'color=c=black:s=320x240:d=1:r=10',
      '-f',
      'lavfi',
      '-i',
      'testsrc=s=320x240:d=1:r=10',
      '-f',
      'lavfi',
      '-i',
      'anullsrc=r=44100:cl=stereo',
      '-filter_complex',
      '[0:v][1:v]concat=n=2:v=1:a=0[v]',
      '-map',
      '[v]',
      '-map',
      '2:a',
      '-shortest',
      '-c:v',
      'libx264',
      '-pix_fmt',
      'yuv420p',
      '-c:a',
      'aac',
      '-t',
      '2',
      fixturePath,
    ]);
  }, 30000);

  afterAll(async () => {
    await fs.rm(fixtureDir, { recursive: true, force: true });
  });

  it('extracts duration and metadata from a real video file', async () => {
    const result = await service.probe(fixturePath);

    expect(result.durationSeconds).toBe(2);
    expect(result.metadata.width).toBe(320);
    expect(result.metadata.height).toBe(240);
    expect(result.metadata.video_codec).toBe('h264');
    expect(result.metadata.audio_codec).toBe('aac');
    expect(result.metadata.container).toBe('mov,mp4,m4a,3gp,3g2,mj2');
  }, 15000);

  it('generates a JPEG thumbnail scaled to 1280px wide that is not the black first frame', async () => {
    const outputPath = path.join(fixtureDir, 'thumb.jpg');

    await service.generateThumbnail(fixturePath, outputPath);

    const stats = await fs.stat(outputPath);
    expect(stats.size).toBeGreaterThan(0);

    const probeResult = await service.probe(outputPath);
    expect(probeResult.metadata.width).toBe(1280);

    // Verify the selected frame is not black: average luma (YAVG) via
    // ffmpeg's signalstats filter. A solid-black frame averages near 0;
    // the colorful testsrc frame the `thumbnail` filter should pick
    // averages well above it.
    const yavg = await new Promise<number>((resolve, reject) => {
      const child = spawn('ffmpeg', [
        '-i',
        outputPath,
        '-vf',
        'signalstats,metadata=print',
        '-f',
        'null',
        '-',
      ]);
      let stderr = '';
      child.stderr.on('data', (d: Buffer) => (stderr += d.toString()));
      child.on('close', () => {
        const match = /lavfi\.signalstats\.YAVG=([\d.]+)/.exec(stderr);
        if (!match) {
          reject(new Error(`YAVG not found in ffmpeg output: ${stderr}`));
          return;
        }
        resolve(parseFloat(match[1]));
      });
    });

    expect(yavg).toBeGreaterThan(50);
  }, 30000);
});
