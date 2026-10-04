import { ListMultipartUploadsCommand, S3Client } from '@aws-sdk/client-s3';
import { getQueueToken } from '@nestjs/bullmq';
import { ConfigModule } from '@nestjs/config';
import { Test, TestingModule } from '@nestjs/testing';
import { TypeOrmModule } from '@nestjs/typeorm';
import type { Queue } from 'bullmq';
import { DataSource, Repository } from 'typeorm';
import { RefreshToken } from '../auth/entities/refresh-token.entity';
import { VerificationToken } from '../auth/entities/verification-token.entity';
import { Channel } from '../channels/entities/channel.entity';
import { ChannelsService } from '../channels/channels.service';
import queueConfig from '../config/queue.config';
import storageConfig from '../config/storage.config';
import { VIDEO_PROCESSING_QUEUE } from '../queue/queue.module';
import { S3_CLIENT } from '../storage/s3-client.provider';
import { StorageService } from '../storage/storage.service';
import {
  cleanAllTables,
  createTestDataSource,
} from '../test/create-test-data-source';
import { User } from '../users/entities/user.entity';
import { Video, VideoStatus } from './entities/video.entity';
import {
  VideoNotFoundException,
  VideoNotOwnedException,
} from './exceptions/video.exception';
import { VideosModule } from './videos.module';
import { VideosService } from './videos.service';
import type { InitUploadResult } from './videos.service';

const ALL_ENTITIES = [User, Channel, RefreshToken, VerificationToken, Video];

describe('VideosService.initUpload (integration)', () => {
  let moduleRef: TestingModule;
  let service: VideosService;
  let dataSource: DataSource;
  let userRepository: Repository<User>;
  let channelRepository: Repository<Channel>;
  let videoRepository: Repository<Video>;

  beforeAll(async () => {
    moduleRef = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({
          isGlobal: true,
          load: [storageConfig, queueConfig],
        }),
        TypeOrmModule.forRoot(createTestDataSource(ALL_ENTITIES).options),
        VideosModule,
      ],
    }).compile();

    service = moduleRef.get(VideosService);
    dataSource = moduleRef.get(DataSource);
    userRepository = dataSource.getRepository(User);
    channelRepository = dataSource.getRepository(Channel);
    videoRepository = dataSource.getRepository(Video);
  });

  afterAll(async () => {
    await moduleRef.close();
  });

  beforeEach(async () => {
    await dataSource.query('DELETE FROM "videos"');
    await cleanAllTables(dataSource);
  });

  let counter = 0;
  async function createUserWithChannel(): Promise<{
    userId: string;
    channelId: string;
  }> {
    const user = await userRepository.save(
      userRepository.create({
        email: `vidsvc_${++counter}@example.com`,
        password: 'hashed',
      }),
    );
    const channel = await channelRepository.save(
      channelRepository.create({
        name: 'Channel',
        nickname: `vidsvc${counter}`,
        user_id: user.id,
      }),
    );
    return { userId: user.id, channelId: channel.id };
  }

  it('persists a row in uploading with upload_id and storage_key populated', async () => {
    const { userId, channelId } = await createUserWithChannel();

    const result = await service.initUpload(userId, {
      title: 'My video',
      size_bytes: 1024,
      mime_type: 'video/mp4',
    });

    expect(result.status).toBe('uploading');
    expect(result.parts.length).toBeGreaterThan(0);

    const row = await videoRepository.findOneBy({
      public_id: result.public_id,
    });
    expect(row).not.toBeNull();
    expect(row!.status).toBe('uploading');
    expect(row!.channel_id).toBe(channelId);
    expect(row!.storage_key).toBe(`videos/${result.public_id}/original`);
    expect(row!.upload_id).toBe(result.upload_id);
  }, 30000);
});

describe('VideosService.completeUpload / abortUpload (integration)', () => {
  let moduleRef: TestingModule;
  let service: VideosService;
  let dataSource: DataSource;
  let userRepository: Repository<User>;
  let channelRepository: Repository<Channel>;
  let videoRepository: Repository<Video>;
  let queue: Queue;
  let s3Client: S3Client;

  beforeAll(async () => {
    moduleRef = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({
          isGlobal: true,
          load: [storageConfig, queueConfig],
        }),
        TypeOrmModule.forRoot(createTestDataSource(ALL_ENTITIES).options),
        VideosModule,
      ],
    }).compile();

    service = moduleRef.get(VideosService);
    dataSource = moduleRef.get(DataSource);
    userRepository = dataSource.getRepository(User);
    channelRepository = dataSource.getRepository(Channel);
    videoRepository = dataSource.getRepository(Video);
    queue = moduleRef.get<Queue>(getQueueToken(VIDEO_PROCESSING_QUEUE));
    s3Client = moduleRef.get(S3_CLIENT);
  });

  afterAll(async () => {
    await moduleRef.close();
  });

  beforeEach(async () => {
    await dataSource.query('DELETE FROM "videos"');
    await cleanAllTables(dataSource);
    await queue.obliterate({ force: true });
  });

  let counter = 0;
  async function createUserWithChannel(): Promise<string> {
    const user = await userRepository.save(
      userRepository.create({
        email: `vidsvc2_${++counter}@example.com`,
        password: 'hashed',
      }),
    );
    await channelRepository.save(
      channelRepository.create({
        name: 'Channel',
        nickname: `vidsvc2${counter}`,
        user_id: user.id,
      }),
    );
    return user.id;
  }

  async function initAndUploadParts(
    userId: string,
    sizeBytes: number,
  ): Promise<{
    init: InitUploadResult;
    parts: { part_number: number; etag: string }[];
  }> {
    const init = await service.initUpload(userId, {
      title: 'Video',
      size_bytes: sizeBytes,
      mime_type: 'video/mp4',
    });

    const parts: { part_number: number; etag: string }[] = [];
    for (const part of init.parts) {
      const body = Buffer.alloc(
        part.part_number < init.parts.length
          ? init.part_size_bytes
          : sizeBytes - init.part_size_bytes * (init.parts.length - 1),
        'a',
      );
      const res = await fetch(part.url, { method: 'PUT', body });
      parts.push({
        part_number: part.part_number,
        etag: res.headers.get('etag') as string,
      });
    }
    return { init, parts };
  }

  it('transitions to processing, clears upload_id, and enqueues exactly one job', async () => {
    const userId = await createUserWithChannel();
    const { init, parts } = await initAndUploadParts(userId, 1024);

    const result = await service.completeUpload(userId, init.public_id, {
      parts,
    });

    expect(result.status).toBe(VideoStatus.PROCESSING);

    const row = await videoRepository.findOneBy({
      public_id: init.public_id,
    });
    expect(row!.upload_id).toBeNull();
    expect(row!.status).toBe(VideoStatus.PROCESSING);

    const counts = await queue.getJobCounts('waiting', 'delayed');
    expect(counts.waiting + counts.delayed).toBe(1);
  }, 30000);

  it('deletes the object and fails the video when the real uploaded size exceeds the ceiling', async () => {
    const userId = await createUserWithChannel();

    // A real 10 GiB payload is impractical to allocate in a test. Instead,
    // drive a second VideosService instance that shares every real
    // dependency (repo, channels, storage, queue) from the compiled module
    // but is constructed with a config object whose uploadMaxSizeBytes is
    // tiny — the admission check at init still passes (declared size below
    // that tiny ceiling), but the real object PUT (a few bytes) then
    // genuinely exceeds it, exercising the HeadObject-based lie detector
    // the same way a multi-GB mismatch would, without the multi-GB I/O.
    const tinyCeilingConfig = { ...storageConfig(), uploadMaxSizeBytes: 10 };
    const serviceWithTinyCeiling = new VideosService(
      videoRepository,
      moduleRef.get(ChannelsService),
      moduleRef.get(StorageService),
      tinyCeilingConfig as any,
      queue,
    );

    const init = await serviceWithTinyCeiling.initUpload(userId, {
      title: 'Video',
      size_bytes: 5,
      mime_type: 'video/mp4',
    });
    const body = Buffer.alloc(20, 'a');
    const part = init.parts[0];
    const res = await fetch(part.url, { method: 'PUT', body });

    await expect(
      serviceWithTinyCeiling.completeUpload(userId, init.public_id, {
        parts: [{ part_number: 1, etag: res.headers.get('etag') as string }],
      }),
    ).rejects.toThrow();

    const row = await videoRepository.findOneBy({
      public_id: init.public_id,
    });
    expect(row!.status).toBe(VideoStatus.FAILED);

    await expect(
      moduleRef.get(StorageService).headObject(row!.storage_key),
    ).rejects.toThrow();

    const counts = await queue.getJobCounts('waiting', 'delayed');
    expect(counts.waiting + counts.delayed).toBe(0);
  }, 30000);

  it('releases the parts on MinIO and returns the video to draft on abort', async () => {
    const userId = await createUserWithChannel();
    const init = await service.initUpload(userId, {
      title: 'Video',
      size_bytes: 1024,
      mime_type: 'video/mp4',
    });

    await service.abortUpload(userId, init.public_id);

    const row = await videoRepository.findOneBy({
      public_id: init.public_id,
    });
    expect(row!.status).toBe(VideoStatus.DRAFT);
    expect(row!.upload_id).toBeNull();

    const { Uploads } = await s3Client.send(
      new ListMultipartUploadsCommand({
        Bucket: storageConfig().s3Bucket,
      }),
    );
    expect((Uploads ?? []).some((u) => u.UploadId === init.upload_id)).toBe(
      false,
    );
  }, 30000);
});

describe('VideosService.findByPublicIdForOwner (integration)', () => {
  let moduleRef: TestingModule;
  let service: VideosService;
  let dataSource: DataSource;
  let userRepository: Repository<User>;
  let channelRepository: Repository<Channel>;
  let videoRepository: Repository<Video>;

  beforeAll(async () => {
    moduleRef = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({
          isGlobal: true,
          load: [storageConfig, queueConfig],
        }),
        TypeOrmModule.forRoot(createTestDataSource(ALL_ENTITIES).options),
        VideosModule,
      ],
    }).compile();

    service = moduleRef.get(VideosService);
    dataSource = moduleRef.get(DataSource);
    userRepository = dataSource.getRepository(User);
    channelRepository = dataSource.getRepository(Channel);
    videoRepository = dataSource.getRepository(Video);
  });

  afterAll(async () => {
    await moduleRef.close();
  });

  beforeEach(async () => {
    await dataSource.query('DELETE FROM "videos"');
    await cleanAllTables(dataSource);
  });

  let counter = 0;
  async function createUserWithChannel(): Promise<{
    userId: string;
    channelId: string;
  }> {
    const user = await userRepository.save(
      userRepository.create({
        email: `vidread_${++counter}@example.com`,
        password: 'hashed',
      }),
    );
    const channel = await channelRepository.save(
      channelRepository.create({
        name: 'Channel',
        nickname: `vidread${counter}`,
        user_id: user.id,
      }),
    );
    return { userId: user.id, channelId: channel.id };
  }

  async function seedVideo(
    channelId: string,
    overrides: Partial<Video> = {},
  ): Promise<Video> {
    const publicId = `rd${counter}${Date.now() % 100000}`;
    return videoRepository.save(
      videoRepository.create({
        public_id: publicId,
        channel_id: channelId,
        title: 'Seeded video',
        status: VideoStatus.PROCESSING,
        storage_key: `videos/${publicId}/original`,
        ...overrides,
      }),
    );
  }

  it('returns the video owned by the authenticated channel', async () => {
    const { userId, channelId } = await createUserWithChannel();
    const video = await seedVideo(channelId);

    const result = await service.findByPublicIdForOwner(
      userId,
      video.public_id,
    );

    expect(result.public_id).toBe(video.public_id);
    expect(result.title).toBe('Seeded video');
    expect(result.status).toBe(VideoStatus.PROCESSING);
  });

  it('nulls duration, metadata and thumbnail_url while processing', async () => {
    const { userId, channelId } = await createUserWithChannel();
    const video = await seedVideo(channelId, {
      status: VideoStatus.PROCESSING,
    });

    const result = await service.findByPublicIdForOwner(
      userId,
      video.public_id,
    );

    expect(result.duration_seconds).toBeNull();
    expect(result.metadata).toBeNull();
    expect(result.thumbnail_url).toBeNull();
  });

  it('exposes metadata and a presigned thumbnail_url when ready', async () => {
    const { userId, channelId } = await createUserWithChannel();
    const video = await seedVideo(channelId, {
      status: VideoStatus.READY,
      duration_seconds: 42,
      metadata: {
        width: 1920,
        height: 1080,
        video_codec: 'h264',
        audio_codec: 'aac',
        container: 'mov,mp4,m4a,3gp,3g2,mj2',
        bitrate: 4500000,
        framerate: 30,
        size_bytes: 1024,
      },
      thumbnail_key: `videos/placeholder/thumbnail.jpg`,
    });

    const result = await service.findByPublicIdForOwner(
      userId,
      video.public_id,
    );

    expect(result.duration_seconds).toBe(42);
    expect(result.metadata?.width).toBe(1920);
    expect(typeof result.thumbnail_url).toBe('string');
    expect(result.thumbnail_url).toBeTruthy();
  });

  it('exposes a non-null processing_error when failed, with other outputs null', async () => {
    const { userId, channelId } = await createUserWithChannel();
    const video = await seedVideo(channelId, {
      status: VideoStatus.FAILED,
      processing_error: 'ffprobe failed: no video stream',
    });

    const result = await service.findByPublicIdForOwner(
      userId,
      video.public_id,
    );

    expect(result.status).toBe(VideoStatus.FAILED);
    expect(result.processing_error).toBe('ffprobe failed: no video stream');
    expect(result.duration_seconds).toBeNull();
    expect(result.metadata).toBeNull();
    expect(result.thumbnail_url).toBeNull();
  });

  it('throws VideoNotOwned for a video belonging to another channel', async () => {
    const owner = await createUserWithChannel();
    const other = await createUserWithChannel();
    const video = await seedVideo(owner.channelId);

    await expect(
      service.findByPublicIdForOwner(other.userId, video.public_id),
    ).rejects.toBeInstanceOf(VideoNotOwnedException);
  });

  it('throws VideoNotFound for an unknown public id', async () => {
    const { userId } = await createUserWithChannel();

    await expect(
      service.findByPublicIdForOwner(userId, 'nonexistent0'),
    ).rejects.toBeInstanceOf(VideoNotFoundException);
  });
});
