import { EventEmitter } from 'node:events';
import { spawn } from 'node:child_process';
import { FfmpegService } from './ffmpeg.service';

jest.mock('node:child_process', () => ({ spawn: jest.fn() }));

const mockedSpawn = spawn as unknown as jest.Mock;

interface MockChildProcess extends EventEmitter {
  stdout: EventEmitter;
  stderr: EventEmitter;
  kill: jest.Mock;
}

function mockSpawn(stdout: string, exitCode = 0): MockChildProcess {
  const child = new EventEmitter() as MockChildProcess;
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.kill = jest.fn();

  mockedSpawn.mockReturnValue(child);

  queueMicrotask(() => {
    if (stdout) child.stdout.emit('data', Buffer.from(stdout));
    child.emit('close', exitCode);
  });

  return child;
}

describe('FfmpegService', () => {
  afterEach(() => {
    mockedSpawn.mockReset();
  });

  describe('probe', () => {
    it('builds ffprobe arguments with -print_format json and the source url', async () => {
      const ffprobeJson = JSON.stringify({
        streams: [
          {
            codec_type: 'video',
            codec_name: 'h264',
            width: 1920,
            height: 1080,
            r_frame_rate: '30/1',
          },
          { codec_type: 'audio', codec_name: 'aac' },
        ],
        format: {
          format_name: 'mov,mp4,m4a,3gp,3g2,mj2',
          duration: '12.5',
          size: '734003200',
          bit_rate: '4500000',
        },
      });
      mockSpawn(ffprobeJson);
      const service = new FfmpegService();

      await service.probe('https://example.com/video.mp4');

      expect(mockedSpawn).toHaveBeenCalledWith('ffprobe', [
        '-v',
        'error',
        '-print_format',
        'json',
        '-show_format',
        '-show_streams',
        'https://example.com/video.mp4',
      ]);
    });

    it('normalizes ffprobe JSON into the metadata shape', async () => {
      const ffprobeJson = JSON.stringify({
        streams: [
          {
            codec_type: 'video',
            codec_name: 'h264',
            width: 1920,
            height: 1080,
            r_frame_rate: '30/1',
          },
          { codec_type: 'audio', codec_name: 'aac' },
        ],
        format: {
          format_name: 'mov,mp4,m4a,3gp,3g2,mj2',
          duration: '12.5',
          size: '734003200',
          bit_rate: '4500000',
        },
      });
      mockSpawn(ffprobeJson);
      const service = new FfmpegService();

      const result = await service.probe('https://example.com/video.mp4');

      expect(result.durationSeconds).toBe(13);
      expect(result.metadata).toEqual({
        width: 1920,
        height: 1080,
        video_codec: 'h264',
        audio_codec: 'aac',
        container: 'mov,mp4,m4a,3gp,3g2,mj2',
        bitrate: 4500000,
        framerate: 30,
        size_bytes: 734003200,
      });
    });

    it('defaults audio_codec to empty string when there is no audio stream', async () => {
      const ffprobeJson = JSON.stringify({
        streams: [
          {
            codec_type: 'video',
            codec_name: 'h264',
            width: 640,
            height: 480,
            r_frame_rate: '25/1',
          },
        ],
        format: {
          format_name: 'mov,mp4,m4a,3gp,3g2,mj2',
          duration: '5',
          size: '1024',
          bit_rate: '100000',
        },
      });
      mockSpawn(ffprobeJson);
      const service = new FfmpegService();

      const result = await service.probe('https://example.com/video.mp4');

      expect(result.metadata.audio_codec).toBe('');
    });

    it('rejects when the probed file has no video stream', async () => {
      const ffprobeJson = JSON.stringify({
        streams: [{ codec_type: 'audio', codec_name: 'aac' }],
        format: { format_name: 'mp3', duration: '5' },
      });
      mockSpawn(ffprobeJson);
      const service = new FfmpegService();

      await expect(
        service.probe('https://example.com/audio.mp3'),
      ).rejects.toThrow('No video stream found');
    });

    it('rejects when ffprobe exits with a non-zero code', async () => {
      mockSpawn('', 1);
      const service = new FfmpegService();

      await expect(
        service.probe('https://example.com/broken.mp4'),
      ).rejects.toThrow('ffprobe exited with code 1');
    });
  });

  describe('generateThumbnail', () => {
    it('builds ffmpeg arguments with the thumbnail+scale filter and output path', async () => {
      mockSpawn('');
      const service = new FfmpegService();

      await service.generateThumbnail(
        'https://example.com/video.mp4',
        '/tmp/out.jpg',
      );

      expect(mockedSpawn).toHaveBeenCalledWith('ffmpeg', [
        '-y',
        '-i',
        'https://example.com/video.mp4',
        '-vf',
        'thumbnail,scale=1280:-1',
        '-frames:v',
        '1',
        '/tmp/out.jpg',
      ]);
    });
  });
});
