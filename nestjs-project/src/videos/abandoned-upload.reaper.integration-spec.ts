import { ListMultipartUploadsCommand, S3Client } from '@aws-sdk/client-s3';
import { ConfigModule } from '@nestjs/config';
import { Test, TestingModule } from '@nestjs/testing';
import { TypeOrmModule } from '@nestjs/typeorm';
import { DataSource, Repository } from 'typeorm';
import { RefreshToken } from '../auth/entities/refresh-token.entity';
import { VerificationToken } from '../auth/entities/verification-token.entity';
import { Channel } from '../channels/entities/channel.entity';
import storageConfig from '../config/storage.config';
import { S3_CLIENT } from '../storage/s3-client.provider';
import { StorageModule } from '../storage/storage.module';
import { StorageService } from '../storage/storage.service';
import {
  cleanAllTables,
  createTestDataSource,
} from '../test/create-test-data-source';
import { User } from '../users/entities/user.entity';
import { AbandonedUploadReaper } from './abandoned-upload.reaper';
import { Video, VideoStatus } from './entities/video.entity';

const ALL_ENTITIES = [User, Channel, RefreshToken, VerificationToken, Video];
const TEST_CUTOFF_HOURS = 1;

describe('AbandonedUploadReaper (integration)', () => {
  let moduleRef: TestingModule;
  let reaper: AbandonedUploadReaper;
  let storageService: StorageService;
  let s3Client: S3Client;
  let dataSource: DataSource;
  let userRepository: Repository<User>;
  let channelRepository: Repository<Channel>;
  let videoRepository: Repository<Video>;

  beforeAll(async () => {
    moduleRef = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({ isGlobal: true, load: [storageConfig] }),
        TypeOrmModule.forRoot(createTestDataSource(ALL_ENTITIES).options),
        TypeOrmModule.forFeature([Video]),
        StorageModule,
      ],
      providers: [AbandonedUploadReaper],
    })
      .overrideProvider(storageConfig.KEY)
      .useValue({
        ...storageConfig(),
        abandonedUploadCutoffHours: TEST_CUTOFF_HOURS,
      })
      .compile();

    reaper = moduleRef.get(AbandonedUploadReaper);
    storageService = moduleRef.get(StorageService);
    s3Client = moduleRef.get(S3_CLIENT);
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
  async function createChannel(): Promise<Channel> {
    const user = await userRepository.save(
      userRepository.create({
        email: `reaper_${++counter}@example.com`,
        password: 'hashed',
      }),
    );
    return channelRepository.save(
      channelRepository.create({
        name: 'Channel',
        nickname: `reaper${counter}`,
        user_id: user.id,
      }),
    );
  }

  async function seedUploadingVideo(
    channelId: string,
    ageHours: number,
  ): Promise<Video> {
    const publicId = `rp${counter}${Date.now() % 100000}`;
    const storageKey = storageService.buildStorageKey(publicId);
    const uploadId = await storageService.createMultipartUpload(
      storageKey,
      'video/mp4',
    );
    const video = await videoRepository.save(
      videoRepository.create({
        public_id: publicId,
        channel_id: channelId,
        title: 'Video',
        status: VideoStatus.UPLOADING,
        storage_key: storageKey,
        upload_id: uploadId,
      }),
    );
    const backdated = new Date(Date.now() - ageHours * 60 * 60 * 1000);
    await dataSource.query(
      'UPDATE "videos" SET updated_at = $1 WHERE id = $2',
      [backdated, video.id],
    );
    return video;
  }

  async function seedDraftVideo(
    channelId: string,
    ageHours: number,
  ): Promise<Video> {
    const publicId = `rpd${counter}${Date.now() % 100000}`;
    const video = await videoRepository.save(
      videoRepository.create({
        public_id: publicId,
        channel_id: channelId,
        title: 'Video',
        status: VideoStatus.DRAFT,
        storage_key: storageService.buildStorageKey(publicId),
      }),
    );
    const backdated = new Date(Date.now() - ageHours * 60 * 60 * 1000);
    await dataSource.query(
      'UPDATE "videos" SET updated_at = $1 WHERE id = $2',
      [backdated, video.id],
    );
    return video;
  }

  it('returns an upload older than the cutoff to draft and releases its parts', async () => {
    const channel = await createChannel();
    const video = await seedUploadingVideo(channel.id, TEST_CUTOFF_HOURS + 1);

    await reaper.run();

    const row = await videoRepository.findOneBy({ id: video.id });
    expect(row!.status).toBe(VideoStatus.DRAFT);
    expect(row!.upload_id).toBeNull();

    const { Uploads } = await s3Client.send(
      new ListMultipartUploadsCommand({ Bucket: storageConfig().s3Bucket }),
    );
    expect((Uploads ?? []).some((u) => u.UploadId === video.upload_id)).toBe(
      false,
    );
  });

  it('leaves an upload more recent than the cutoff untouched', async () => {
    const channel = await createChannel();
    const video = await seedUploadingVideo(channel.id, TEST_CUTOFF_HOURS / 2);

    await reaper.run();

    const row = await videoRepository.findOneBy({ id: video.id });
    expect(row!.status).toBe(VideoStatus.UPLOADING);
    expect(row!.upload_id).toBe(video.upload_id);
  });

  it('never touches a draft video regardless of age', async () => {
    const channel = await createChannel();
    const video = await seedDraftVideo(channel.id, TEST_CUTOFF_HOURS * 100);
    const beforeRun = await videoRepository.findOneBy({ id: video.id });

    await reaper.run();

    const row = await videoRepository.findOneBy({ id: video.id });
    expect(row!.status).toBe(VideoStatus.DRAFT);
    expect(row!.updated_at.getTime()).toBe(beforeRun!.updated_at.getTime());
  });

  it('running twice produces no error and no additional effect', async () => {
    const channel = await createChannel();
    const video = await seedUploadingVideo(channel.id, TEST_CUTOFF_HOURS + 1);

    await reaper.run();
    const afterFirstRun = await videoRepository.findOneBy({ id: video.id });

    await expect(reaper.run()).resolves.toBeUndefined();
    const afterSecondRun = await videoRepository.findOneBy({ id: video.id });

    expect(afterSecondRun!.status).toBe(VideoStatus.DRAFT);
    expect(afterSecondRun!.upload_id).toBeNull();
    expect(afterSecondRun!.updated_at.getTime()).toBe(
      afterFirstRun!.updated_at.getTime(),
    );
  });
});
