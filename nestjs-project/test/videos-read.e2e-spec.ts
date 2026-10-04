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
import { StorageService } from '../src/storage/storage.service';
import { cleanAllTables } from '../src/test/create-test-data-source';
import { Video, VideoStatus } from '../src/videos/entities/video.entity';

describe('GET /videos/:publicId (e2e)', () => {
  let app: INestApplication<App>;
  let dataSource: DataSource;
  let throttlerStorage: ThrottlerStorageService;
  let channelRepository: Repository<Channel>;
  let videoRepository: Repository<Video>;
  let storageService: StorageService;

  beforeAll(async () => {
    const moduleFixture = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

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
    const email = `video_read_${++userCounter}@example.com`;
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
  async function seedVideo(
    channelId: string,
    overrides: Partial<Video> = {},
  ): Promise<Video> {
    const publicId = `rd${++videoCounter}${Date.now() % 100000}`;
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

  describe('State-dependent response shape', () => {
    it('returns core fields for the owned video', async () => {
      const { accessToken, channelId } = await registerConfirmAndLogin();
      const video = await seedVideo(channelId);

      const res = await request(app.getHttpServer())
        .get(`/videos/${video.public_id}`)
        .set('Authorization', `Bearer ${accessToken}`)
        .expect(200);

      expect(res.body.public_id).toBe(video.public_id);
      expect(res.body.title).toBe('Seeded video');
      expect(['draft', 'uploading', 'processing', 'ready', 'failed']).toContain(
        res.body.status,
      );
      expect(Number.isNaN(Date.parse(res.body.created_at))).toBe(false);
    });

    it('nulls processing outputs while processing', async () => {
      const { accessToken, channelId } = await registerConfirmAndLogin();
      const video = await seedVideo(channelId, {
        status: VideoStatus.PROCESSING,
      });

      const res = await request(app.getHttpServer())
        .get(`/videos/${video.public_id}`)
        .set('Authorization', `Bearer ${accessToken}`)
        .expect(200);

      expect(res.body.status).toBe('processing');
      expect(res.body.duration_seconds).toBeNull();
      expect(res.body.metadata).toBeNull();
      expect(res.body.thumbnail_url).toBeNull();
    });

    it('exposes metadata and a servable thumbnail when ready', async () => {
      const { accessToken, channelId } = await registerConfirmAndLogin();
      const video = await seedVideo(channelId, { status: VideoStatus.DRAFT });
      const thumbnailKey = storageService.buildThumbnailKey(video.public_id);
      await storageService.putObject(
        thumbnailKey,
        Buffer.from([0xff, 0xd8, 0xff, 0xdb]),
        'image/jpeg',
      );
      video.status = VideoStatus.READY;
      video.duration_seconds = 12;
      video.metadata = {
        width: 1920,
        height: 1080,
        video_codec: 'h264',
        audio_codec: 'aac',
        container: 'mov,mp4,m4a,3gp,3g2,mj2',
        bitrate: 4500000,
        framerate: 30,
        size_bytes: 1024,
      };
      video.thumbnail_key = thumbnailKey;
      await videoRepository.save(video);

      const res = await request(app.getHttpServer())
        .get(`/videos/${video.public_id}`)
        .set('Authorization', `Bearer ${accessToken}`)
        .expect(200);

      expect(res.body.duration_seconds).toBeGreaterThan(0);
      expect(res.body.metadata).toMatchObject({
        width: 1920,
        height: 1080,
        video_codec: 'h264',
        container: 'mov,mp4,m4a,3gp,3g2,mj2',
        size_bytes: 1024,
      });
      expect(typeof res.body.thumbnail_url).toBe('string');
      expect(res.body.thumbnail_url.length).toBeGreaterThan(0);

      const imageRes = await fetch(res.body.thumbnail_url);
      expect(imageRes.status).toBe(200);
      expect(imageRes.headers.get('content-type')).toMatch(/^image\//);
    }, 15000);

    it('exposes the error reason when failed, with other outputs null', async () => {
      const { accessToken, channelId } = await registerConfirmAndLogin();
      const video = await seedVideo(channelId, {
        status: VideoStatus.FAILED,
        processing_error: 'ffprobe failed: no video stream',
      });

      const res = await request(app.getHttpServer())
        .get(`/videos/${video.public_id}`)
        .set('Authorization', `Bearer ${accessToken}`)
        .expect(200);

      expect(res.body.status).toBe('failed');
      expect(res.body.processing_error).toBe('ffprobe failed: no video stream');
      expect(res.body.duration_seconds).toBeNull();
      expect(res.body.metadata).toBeNull();
      expect(res.body.thumbnail_url).toBeNull();
    });
  });

  describe('Authorization boundary', () => {
    it('rejects a read by a non-owner and leaks no video field', async () => {
      const owner = await registerConfirmAndLogin();
      const other = await registerConfirmAndLogin();
      const video = await seedVideo(owner.channelId);

      const res = await request(app.getHttpServer())
        .get(`/videos/${video.public_id}`)
        .set('Authorization', `Bearer ${other.accessToken}`)
        .expect(403);

      expect(res.body.error).toBe('VIDEO_NOT_OWNED');
      expect(res.body.title).toBeUndefined();
      expect(res.body.status).toBeUndefined();
    });

    it('returns 404 for an unknown public id', async () => {
      const { accessToken } = await registerConfirmAndLogin();

      const res = await request(app.getHttpServer())
        .get('/videos/nonexistent0')
        .set('Authorization', `Bearer ${accessToken}`)
        .expect(404);

      expect(res.body.error).toBe('VIDEO_NOT_FOUND');
    });

    it('rejects a read without an access token', async () => {
      const { channelId } = await registerConfirmAndLogin();
      const video = await seedVideo(channelId);

      const res = await request(app.getHttpServer())
        .get(`/videos/${video.public_id}`)
        .expect(401);

      expect(res.body.title).toBeUndefined();
    });
  });
});
