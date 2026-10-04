import { INestApplication, ValidationPipe } from '@nestjs/common';
import { ThrottlerStorage, ThrottlerStorageService } from '@nestjs/throttler';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { App } from 'supertest/types';
import { DataSource, Repository } from 'typeorm';
import { AppModule } from '../src/app.module';
import { AuthService } from '../src/auth/auth.service';
import { Channel } from '../src/channels/entities/channel.entity';
import { DomainExceptionFilter } from '../src/common/filters/domain-exception.filter';
import { ValidationExceptionFilter } from '../src/common/filters/validation-exception.filter';
import storageConfig from '../src/config/storage.config';
import { StorageService } from '../src/storage/storage.service';
import { cleanAllTables } from '../src/test/create-test-data-source';
import { Video, VideoStatus } from '../src/videos/entities/video.entity';

const TEST_PRESIGN_DOWNLOAD_TTL_SECONDS = 2;

describe('GET /videos/:publicId/stream and /download (e2e)', () => {
  let app: INestApplication<App>;
  let dataSource: DataSource;
  let throttlerStorage: ThrottlerStorageService;
  let channelRepository: Repository<Channel>;
  let videoRepository: Repository<Video>;
  let storageService: StorageService;

  beforeAll(async () => {
    const moduleFixture = await Test.createTestingModule({
      imports: [AppModule],
    })
      .overrideProvider(storageConfig.KEY)
      .useValue({
        ...storageConfig(),
        presignDownloadTtlSeconds: TEST_PRESIGN_DOWNLOAD_TTL_SECONDS,
      })
      .compile();

    app = moduleFixture.createNestApplication();
    app.useGlobalPipes(
      new ValidationPipe({
        whitelist: true,
        forbidNonWhitelisted: true,
        transform: true,
      }),
    );
    app.useGlobalFilters(
      new DomainExceptionFilter(),
      new ValidationExceptionFilter(),
    );
    await app.init();

    dataSource = moduleFixture.get(DataSource);
    throttlerStorage =
      moduleFixture.get<ThrottlerStorageService>(ThrottlerStorage);
    channelRepository = dataSource.getRepository(Channel);
    videoRepository = dataSource.getRepository(Video);
    storageService = moduleFixture.get(StorageService);
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(async () => {
    await dataSource.query('DELETE FROM "videos"');
    await cleanAllTables(dataSource);
    throttlerStorage.storage.clear();
  });

  let userCounter = 0;
  async function registerConfirmAndLogin(): Promise<{
    accessToken: string;
    channelId: string;
  }> {
    const email = `video_delivery_${++userCounter}@example.com`;
    const password = 'password123';

    const authService = app.get(AuthService);
    const mailServiceInstance = (authService as any).mailService;
    let capturedToken = '';
    jest
      .spyOn(mailServiceInstance, 'sendConfirmationEmail')
      .mockImplementationOnce(async (_e: string, _n: string, t: string) => {
        capturedToken = t;
      });

    const registerRes = await request(app.getHttpServer())
      .post('/auth/register')
      .send({ email, password });
    await request(app.getHttpServer())
      .get('/auth/confirm-email')
      .query({ token: capturedToken });
    const loginRes = await request(app.getHttpServer())
      .post('/auth/login')
      .send({ email, password });

    const channel = await channelRepository.findOneBy({
      user_id: registerRes.body.id,
    });

    return {
      accessToken: loginRes.body.access_token as string,
      channelId: channel!.id,
    };
  }

  let videoCounter = 0;
  async function seedReadyVideo(channelId: string): Promise<Video> {
    const publicId = `dv${++videoCounter}${Date.now() % 100000}`;
    const storageKey = storageService.buildStorageKey(publicId);
    await storageService.putObject(
      storageKey,
      Buffer.alloc(2048, 'a'),
      'video/mp4',
    );
    return videoRepository.save(
      videoRepository.create({
        public_id: publicId,
        channel_id: channelId,
        title: 'Video',
        status: VideoStatus.READY,
        storage_key: storageKey,
      }),
    );
  }

  async function seedVideoInState(
    channelId: string,
    status: VideoStatus,
  ): Promise<Video> {
    const publicId = `dv${++videoCounter}${Date.now() % 100000}`;
    return videoRepository.save(
      videoRepository.create({
        public_id: publicId,
        channel_id: channelId,
        title: 'Video',
        status,
        storage_key: storageService.buildStorageKey(publicId),
      }),
    );
  }

  describe('Streaming delivery', () => {
    it('redirects to a presigned URL', async () => {
      const { accessToken, channelId } = await registerConfirmAndLogin();
      const video = await seedReadyVideo(channelId);

      const res = await request(app.getHttpServer())
        .get(`/videos/${video.public_id}/stream`)
        .set('Authorization', `Bearer ${accessToken}`)
        .redirects(0)
        .expect(302);

      expect(res.headers.location).toBeTruthy();
      expect(res.headers.location).toMatch(/X-Amz-Signature=/);
      expect(res.body).toEqual({});
    });

    it('honours a Range request with 206', async () => {
      const { accessToken, channelId } = await registerConfirmAndLogin();
      const video = await seedReadyVideo(channelId);

      const res = await request(app.getHttpServer())
        .get(`/videos/${video.public_id}/stream`)
        .set('Authorization', `Bearer ${accessToken}`)
        .redirects(0)
        .expect(302);
      const location = res.headers.location;

      const rangeRes = await fetch(location, {
        headers: { Range: 'bytes=0-1023' },
      });
      expect(rangeRes.status).toBe(206);
      expect(rangeRes.headers.get('content-range')).toBeTruthy();
      const rangeBody = await rangeRes.arrayBuffer();
      expect(rangeBody.byteLength).toBe(1024);

      const fullRes = await fetch(location);
      expect(fullRes.status).toBe(200);
      const fullBody = await fullRes.arrayBuffer();
      expect(fullBody.byteLength).toBe(2048);
    });
  });

  describe('Download delivery', () => {
    it('redirects with attachment disposition', async () => {
      const { accessToken, channelId } = await registerConfirmAndLogin();
      const video = await seedReadyVideo(channelId);

      const res = await request(app.getHttpServer())
        .get(`/videos/${video.public_id}/download`)
        .set('Authorization', `Bearer ${accessToken}`)
        .redirects(0)
        .expect(302);
      const location = res.headers.location;

      const followed = await fetch(location);
      expect(followed.status).toBe(200);
      expect(followed.headers.get('content-disposition')).toMatch(
        /^attachment/,
      );
    });
  });

  describe('Guards, authorization and expiry', () => {
    it('stops accepting the presigned URL after the configured TTL', async () => {
      const { accessToken, channelId } = await registerConfirmAndLogin();
      const video = await seedReadyVideo(channelId);

      const res = await request(app.getHttpServer())
        .get(`/videos/${video.public_id}/stream`)
        .set('Authorization', `Bearer ${accessToken}`)
        .redirects(0)
        .expect(302);
      const location = res.headers.location;

      const immediate = await fetch(location);
      expect(immediate.status).toBe(200);

      await new Promise((resolve) =>
        setTimeout(resolve, (TEST_PRESIGN_DOWNLOAD_TTL_SECONDS + 1) * 1000),
      );

      const expired = await fetch(location);
      expect(expired.status).toBe(403);
    }, 15000);

    it('rejects delivery outside the ready state for all four non-ready statuses', async () => {
      const { accessToken, channelId } = await registerConfirmAndLogin();

      for (const status of [
        VideoStatus.DRAFT,
        VideoStatus.UPLOADING,
        VideoStatus.PROCESSING,
        VideoStatus.FAILED,
      ]) {
        const video = await seedVideoInState(channelId, status);

        const res = await request(app.getHttpServer())
          .get(`/videos/${video.public_id}/stream`)
          .set('Authorization', `Bearer ${accessToken}`)
          .redirects(0)
          .expect(409);

        expect(res.body.error).toBe('VIDEO_NOT_READY');
        expect(res.headers.location).toBeUndefined();
      }
    });

    it('rejects delivery by a non-owner for both stream and download', async () => {
      const owner = await registerConfirmAndLogin();
      const other = await registerConfirmAndLogin();
      const video = await seedReadyVideo(owner.channelId);

      const streamRes = await request(app.getHttpServer())
        .get(`/videos/${video.public_id}/stream`)
        .set('Authorization', `Bearer ${other.accessToken}`)
        .redirects(0)
        .expect(403);
      expect(streamRes.body.error).toBe('VIDEO_NOT_OWNED');
      expect(streamRes.headers.location).toBeUndefined();

      const downloadRes = await request(app.getHttpServer())
        .get(`/videos/${video.public_id}/download`)
        .set('Authorization', `Bearer ${other.accessToken}`)
        .redirects(0)
        .expect(403);
      expect(downloadRes.body.error).toBe('VIDEO_NOT_OWNED');
    });

    it('rejects delivery without an access token for both stream and download', async () => {
      const { channelId } = await registerConfirmAndLogin();
      const video = await seedReadyVideo(channelId);

      await request(app.getHttpServer())
        .get(`/videos/${video.public_id}/stream`)
        .redirects(0)
        .expect(401);

      await request(app.getHttpServer())
        .get(`/videos/${video.public_id}/download`)
        .redirects(0)
        .expect(401);
    });
  });
});
