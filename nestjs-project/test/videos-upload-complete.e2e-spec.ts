import { getQueueToken } from '@nestjs/bullmq';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { ThrottlerStorage, ThrottlerStorageService } from '@nestjs/throttler';
import { Test } from '@nestjs/testing';
import type { Queue } from 'bullmq';
import request from 'supertest';
import { App } from 'supertest/types';
import { DataSource } from 'typeorm';
import { AppModule } from '../src/app.module';
import { AuthService } from '../src/auth/auth.service';
import { DomainExceptionFilter } from '../src/common/filters/domain-exception.filter';
import { ValidationExceptionFilter } from '../src/common/filters/validation-exception.filter';
import storageConfig from '../src/config/storage.config';
import { VIDEO_PROCESSING_QUEUE } from '../src/queue/queue.module';
import { cleanAllTables } from '../src/test/create-test-data-source';

// Overriding uploadMaxSizeBytes to a small value keeps the "exceeds ceiling"
// scenario cheap: a real multi-GB payload is impractical in a test, but a
// small ceiling lets a tiny real PUT genuinely exceed it, exercising the
// same HeadObject-based lie detector the production 10 GiB ceiling uses.
const TEST_UPLOAD_MAX_SIZE_BYTES = 51200;

describe('POST /videos/:publicId/complete and DELETE /videos/:publicId/upload (e2e)', () => {
  let app: INestApplication<App>;
  let dataSource: DataSource;
  let throttlerStorage: ThrottlerStorageService;
  let queue: Queue;

  beforeAll(async () => {
    const moduleFixture = await Test.createTestingModule({
      imports: [AppModule],
    })
      .overrideProvider(storageConfig.KEY)
      .useValue({
        ...storageConfig(),
        uploadMaxSizeBytes: TEST_UPLOAD_MAX_SIZE_BYTES,
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
    queue = moduleFixture.get<Queue>(getQueueToken(VIDEO_PROCESSING_QUEUE));
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(async () => {
    await dataSource.query('DELETE FROM "videos"');
    await cleanAllTables(dataSource);
    throttlerStorage.storage.clear();
    await queue.obliterate({ force: true });
  });

  let userCounter = 0;
  async function registerConfirmAndLogin(): Promise<string> {
    const email = `video_complete_${++userCounter}@example.com`;
    const password = 'password123';

    const authService = app.get(AuthService);
    const mailServiceInstance = (authService as any).mailService;
    let capturedToken = '';
    jest
      .spyOn(mailServiceInstance, 'sendConfirmationEmail')
      .mockImplementationOnce(async (_e: string, _n: string, t: string) => {
        capturedToken = t;
      });

    await request(app.getHttpServer())
      .post('/auth/register')
      .send({ email, password });
    await request(app.getHttpServer())
      .get('/auth/confirm-email')
      .query({ token: capturedToken });
    const res = await request(app.getHttpServer())
      .post('/auth/login')
      .send({ email, password });

    return res.body.access_token as string;
  }

  async function initAndUploadParts(
    token: string,
    sizeBytes: number,
    realBytesOverride?: number,
  ): Promise<{
    publicId: string;
    parts: { part_number: number; etag: string }[];
  }> {
    const initRes = await request(app.getHttpServer())
      .post('/videos')
      .set('Authorization', `Bearer ${token}`)
      .send({ title: 'Video', size_bytes: sizeBytes, mime_type: 'video/mp4' })
      .expect(201);

    // realBytesOverride lets a test declare one (admissible) size at init
    // while uploading a different real size — e.g. to prove the server
    // catches a lying client at completion via HeadObject.
    const realBytes = realBytesOverride ?? sizeBytes;
    const parts: { part_number: number; etag: string }[] = [];
    const partSizeBytes = initRes.body.part_size_bytes as number;
    const uploadParts = initRes.body.parts as {
      part_number: number;
      url: string;
    }[];
    for (const part of uploadParts) {
      const body = Buffer.alloc(
        part.part_number < uploadParts.length
          ? partSizeBytes
          : realBytes - partSizeBytes * (uploadParts.length - 1),
        'a',
      );
      const putRes = await fetch(part.url, { method: 'PUT', body });
      parts.push({
        part_number: part.part_number,
        etag: putRes.headers.get('etag') as string,
      });
    }

    return { publicId: initRes.body.public_id as string, parts };
  }

  describe('Successful completion', () => {
    it('completes the upload and enqueues exactly one processing job', async () => {
      const token = await registerConfirmAndLogin();
      const { publicId, parts } = await initAndUploadParts(token, 1024);

      const res = await request(app.getHttpServer())
        .post(`/videos/${publicId}/complete`)
        .set('Authorization', `Bearer ${token}`)
        .send({ parts })
        .expect(200);

      expect(res.body.public_id).toBe(publicId);
      expect(res.body.status).toBe('processing');

      const counts = await queue.getJobCounts('waiting', 'delayed');
      expect(counts.waiting + counts.delayed).toBe(1);
      const jobs = await queue.getJobs(['waiting', 'delayed']);
      expect(jobs[0].data.publicId).toBe(publicId);
    }, 30000);

    it('clears upload_id and materializes the object at videos/{publicId}/original', async () => {
      const token = await registerConfirmAndLogin();
      const { publicId, parts } = await initAndUploadParts(token, 1024);

      await request(app.getHttpServer())
        .post(`/videos/${publicId}/complete`)
        .set('Authorization', `Bearer ${token}`)
        .send({ parts })
        .expect(200);

      const rows = await dataSource.query(
        'SELECT * FROM "videos" WHERE public_id = $1',
        [publicId],
      );
      expect(rows[0].upload_id).toBeNull();
      expect(rows[0].status).toBe('processing');
    }, 30000);
  });

  describe('Guards and rejections', () => {
    it('rejects completion by a non-owner', async () => {
      const ownerToken = await registerConfirmAndLogin();
      const otherToken = await registerConfirmAndLogin();
      const { publicId, parts } = await initAndUploadParts(ownerToken, 1024);

      const res = await request(app.getHttpServer())
        .post(`/videos/${publicId}/complete`)
        .set('Authorization', `Bearer ${otherToken}`)
        .send({ parts })
        .expect(403);

      expect(res.body.error).toBe('VIDEO_NOT_OWNED');

      const rows = await dataSource.query(
        'SELECT status FROM "videos" WHERE public_id = $1',
        [publicId],
      );
      expect(rows[0].status).toBe('uploading');
    }, 30000);

    it('rejects completion outside the uploading state', async () => {
      const token = await registerConfirmAndLogin();
      const { publicId, parts } = await initAndUploadParts(token, 1024);

      await request(app.getHttpServer())
        .post(`/videos/${publicId}/complete`)
        .set('Authorization', `Bearer ${token}`)
        .send({ parts })
        .expect(200);

      const res = await request(app.getHttpServer())
        .post(`/videos/${publicId}/complete`)
        .set('Authorization', `Bearer ${token}`)
        .send({ parts })
        .expect(409);

      expect(res.body.error).toBe('VIDEO_INVALID_STATE_TRANSITION');

      const counts = await queue.getJobCounts('waiting', 'delayed');
      expect(counts.waiting + counts.delayed).toBe(1);
    }, 30000);

    it('rejects an object whose real size exceeds the ceiling, deletes it, and fails the video', async () => {
      const token = await registerConfirmAndLogin();
      // Declare a size under the test ceiling so init admits it, then PUT
      // real content above the ceiling — the presigned PUT cannot refuse it.
      const { publicId, parts } = await initAndUploadParts(
        token,
        1024,
        TEST_UPLOAD_MAX_SIZE_BYTES + 1024,
      );

      const res = await request(app.getHttpServer())
        .post(`/videos/${publicId}/complete`)
        .set('Authorization', `Bearer ${token}`)
        .send({ parts })
        .expect(400);

      expect(res.body.error).toBe('VIDEO_SIZE_EXCEEDS_LIMIT');

      const rows = await dataSource.query(
        'SELECT status, storage_key FROM "videos" WHERE public_id = $1',
        [publicId],
      );
      expect(rows[0].status).toBe('failed');

      const counts = await queue.getJobCounts('waiting', 'delayed');
      expect(counts.waiting + counts.delayed).toBe(0);
    }, 30000);

    it('returns 404 for an unknown public id', async () => {
      const token = await registerConfirmAndLogin();

      const res = await request(app.getHttpServer())
        .post('/videos/nonexistent0/complete')
        .set('Authorization', `Bearer ${token}`)
        .send({ parts: [{ part_number: 1, etag: 'abc' }] })
        .expect(404);

      expect(res.body.error).toBe('VIDEO_NOT_FOUND');
    });
  });

  describe('Abort path', () => {
    it('aborts the upload and returns the video to draft', async () => {
      const token = await registerConfirmAndLogin();
      const initRes = await request(app.getHttpServer())
        .post('/videos')
        .set('Authorization', `Bearer ${token}`)
        .send({ title: 'Video', size_bytes: 1024, mime_type: 'video/mp4' })
        .expect(201);
      const publicId = initRes.body.public_id as string;

      const res = await request(app.getHttpServer())
        .delete(`/videos/${publicId}/upload`)
        .set('Authorization', `Bearer ${token}`)
        .expect(204);

      expect(res.body).toEqual({});

      const rows = await dataSource.query(
        'SELECT status, upload_id FROM "videos" WHERE public_id = $1',
        [publicId],
      );
      expect(rows[0].status).toBe('draft');
      expect(rows[0].upload_id).toBeNull();
    }, 30000);
  });
});
