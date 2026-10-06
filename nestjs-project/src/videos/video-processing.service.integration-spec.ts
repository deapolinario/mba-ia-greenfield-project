import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { ConfigModule } from '@nestjs/config';
import { Test, TestingModule } from '@nestjs/testing';
import { TypeOrmModule } from '@nestjs/typeorm';
import type { Job } from 'bullmq';
import { DataSource, Repository } from 'typeorm';
import { Channel } from '../channels/entities/channel.entity';
import storageConfig from '../config/storage.config';
import { StorageModule } from '../storage/storage.module';
import { StorageService } from '../storage/storage.service';
import {
  cleanAllTables,
  createTestDataSource,
} from '../test/create-test-data-source';
import { User } from '../users/entities/user.entity';
import { Video, VideoStatus } from './entities/video.entity';
import { FfmpegService } from './ffmpeg.service';
import type { VideoProcessingJobPayload } from './video-processing.job';
import { VideoProcessingService } from './video-processing.service';

const ALL_ENTITIES = [User, Channel, Video];

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

function makeFakeJob(
  data: VideoProcessingJobPayload,
  attempts = 3,
): Job<VideoProcessingJobPayload> {
  return {
    data,
    attemptsMade: 0,
    opts: { attempts },
  } as Job<VideoProcessingJobPayload>;
}

describe('VideoProcessingService (integration)', () => {
  let moduleRef: TestingModule;
  let service: VideoProcessingService;
  let storageService: StorageService;
  let dataSource: DataSource;
  let userRepository: Repository<User>;
  let channelRepository: Repository<Channel>;
  let videoRepository: Repository<Video>;
  let fixtureDir: string;
  let validFixturePath: string;

  beforeAll(async () => {
    moduleRef = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({ isGlobal: true, load: [storageConfig] }),
        TypeOrmModule.forRoot(createTestDataSource(ALL_ENTITIES).options),
        TypeOrmModule.forFeature(ALL_ENTITIES),
        StorageModule,
      ],
      providers: [VideoProcessingService, FfmpegService],
    }).compile();

    service = moduleRef.get(VideoProcessingService);
    storageService = moduleRef.get(StorageService);
    dataSource = moduleRef.get(DataSource);
    userRepository = dataSource.getRepository(User);
    channelRepository = dataSource.getRepository(Channel);
    videoRepository = dataSource.getRepository(Video);

    fixtureDir = await fs.mkdtemp(
      path.join(os.tmpdir(), 'video-processing-fixture-'),
    );
    validFixturePath = path.join(fixtureDir, 'valid.mp4');
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
      '-filter_complex',
      '[0:v][1:v]concat=n=2:v=1:a=0[v]',
      '-map',
      '[v]',
      '-c:v',
      'libx264',
      '-pix_fmt',
      'yuv420p',
      '-t',
      '2',
      validFixturePath,
    ]);
  }, 30000);

  afterAll(async () => {
    await fs.rm(fixtureDir, { recursive: true, force: true });
    await moduleRef.close();
  });

  beforeEach(async () => {
    await cleanAllTables(dataSource);
  });

  let counter = 0;
  async function createVideoRow(
    overrides: Partial<Video> = {},
  ): Promise<Video> {
    const user = await userRepository.save(
      userRepository.create({
        email: `vidproc_${++counter}@example.com`,
        password: 'hashed',
      }),
    );
    const channel = await channelRepository.save(
      channelRepository.create({
        name: 'Channel',
        nickname: `vidproc${counter}`,
        user_id: user.id,
      }),
    );
    const publicId = `pub${counter}${randomUUID().slice(0, 4)}`;
    const storageKey = storageService.buildStorageKey(publicId);
    return videoRepository.save(
      videoRepository.create({
        public_id: publicId,
        channel_id: channel.id,
        title: 'Video',
        status: VideoStatus.PROCESSING,
        storage_key: storageKey,
        declared_mime_type: 'video/mp4',
        declared_size_bytes: '1024',
        ...overrides,
      }),
    );
  }

  async function uploadFixtureAt(storageKey: string, filePath: string) {
    const body = await fs.readFile(filePath);
    await storageService.putObject(storageKey, body, 'video/mp4');
  }

  it('processes a valid video end-to-end: ready with duration, metadata and thumbnail', async () => {
    const video = await createVideoRow();
    await uploadFixtureAt(video.storage_key, validFixturePath);

    await service.process(
      makeFakeJob({
        videoId: video.id,
        publicId: video.public_id,
        storageKey: video.storage_key,
      }),
    );

    const row = await videoRepository.findOneBy({ id: video.id });
    expect(row!.status).toBe(VideoStatus.READY);
    expect(row!.duration_seconds).toBe(2);
    expect(row!.metadata?.width).toBe(320);
    expect(row!.metadata?.height).toBe(240);
    expect(row!.metadata?.video_codec).toBe('h264');
    expect(row!.metadata?.container).toBe('mov,mp4,m4a,3gp,3g2,mj2');
    expect(row!.thumbnail_key).toBe(
      storageService.buildThumbnailKey(video.public_id),
    );
    expect(row!.processing_error).toBeNull();

    const thumbnailHead = await storageService.headObject(
      row!.thumbnail_key as string,
    );
    expect(thumbnailHead.ContentLength).toBeGreaterThan(0);
  }, 30000);

  it('fails the video when the real container diverges from the declared MIME type (on the final attempt)', async () => {
    const video = await createVideoRow({ declared_mime_type: 'video/webm' });
    await uploadFixtureAt(video.storage_key, validFixturePath);

    await service.process(
      makeFakeJob(
        {
          videoId: video.id,
          publicId: video.public_id,
          storageKey: video.storage_key,
        },
        1,
      ),
    );

    const row = await videoRepository.findOneBy({ id: video.id });
    expect(row!.status).toBe(VideoStatus.FAILED);
    expect(row!.processing_error).toBeTruthy();
    expect(row!.duration_seconds).toBeNull();
    expect(row!.metadata).toBeNull();
    expect(row!.thumbnail_key).toBeNull();
  }, 30000);

  it('re-throws (for BullMQ to retry) when the attempt is not yet final', async () => {
    const video = await createVideoRow({ declared_mime_type: 'video/webm' });
    await uploadFixtureAt(video.storage_key, validFixturePath);

    await expect(
      service.process(
        makeFakeJob(
          {
            videoId: video.id,
            publicId: video.public_id,
            storageKey: video.storage_key,
          },
          3,
        ),
      ),
    ).rejects.toThrow();

    const row = await videoRepository.findOneBy({ id: video.id });
    expect(row!.status).toBe(VideoStatus.PROCESSING);
    expect(row!.processing_error).toBeNull();
  }, 30000);

  it('converges on re-run: stays ready and does not duplicate the thumbnail object', async () => {
    const video = await createVideoRow();
    await uploadFixtureAt(video.storage_key, validFixturePath);
    const job = makeFakeJob({
      videoId: video.id,
      publicId: video.public_id,
      storageKey: video.storage_key,
    });

    await service.process(job);
    const firstRun = await videoRepository.findOneBy({ id: video.id });

    await service.process(job);
    const secondRun = await videoRepository.findOneBy({ id: video.id });

    expect(secondRun!.status).toBe(VideoStatus.READY);
    expect(secondRun!.thumbnail_key).toBe(firstRun!.thumbnail_key);

    const head = await storageService.headObject(
      secondRun!.thumbnail_key as string,
    );
    expect(head.ContentLength).toBeGreaterThan(0);
  }, 30000);
});
