import { INestApplication, ValidationPipe } from '@nestjs/common';
import { ThrottlerStorage, ThrottlerStorageService } from '@nestjs/throttler';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { App } from 'supertest/types';
import { DataSource } from 'typeorm';
import { AppModule } from '../src/app.module';
import { AuthService } from '../src/auth/auth.service';
import { DomainExceptionFilter } from '../src/common/filters/domain-exception.filter';
import { ValidationExceptionFilter } from '../src/common/filters/validation-exception.filter';
import { cleanAllTables } from '../src/test/create-test-data-source';

describe('POST /videos (e2e)', () => {
  let app: INestApplication<App>;
  let dataSource: DataSource;
  let throttlerStorage: ThrottlerStorageService;

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
  async function registerConfirmAndLogin(): Promise<string> {
    const email = `video_upload_${++userCounter}@example.com`;
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

  describe('Successful initiation', () => {
    it('returns presigned parts for a valid declaration', async () => {
      const token = await registerConfirmAndLogin();

      const res = await request(app.getHttpServer())
        .post('/videos')
        .set('Authorization', `Bearer ${token}`)
        .send({
          title: 'Meu vídeo',
          size_bytes: 20971520,
          mime_type: 'video/mp4',
        })
        .expect(201);

      expect(typeof res.body.public_id).toBe('string');
      expect(res.body.public_id.length).toBeGreaterThan(0);
      expect(res.body.status).toBe('uploading');
      expect(typeof res.body.upload_id).toBe('string');
      expect(res.body.upload_id.length).toBeGreaterThan(0);
      expect(typeof res.body.part_size_bytes).toBe('number');
      expect(Array.isArray(res.body.parts)).toBe(true);
      expect(res.body.parts.length).toBeGreaterThan(0);
    }, 30000);

    it('returns consecutive signed part entries sized to the declared bytes', async () => {
      const token = await registerConfirmAndLogin();
      const sizeBytes = 20 * 1024 * 1024;

      const res = await request(app.getHttpServer())
        .post('/videos')
        .set('Authorization', `Bearer ${token}`)
        .send({
          title: 'Multi-part',
          size_bytes: sizeBytes,
          mime_type: 'video/mp4',
        })
        .expect(201);

      const parts = res.body.parts as Array<{
        part_number: number;
        url: string;
        expires_at: string;
      }>;
      parts.forEach((part, idx) => {
        expect(part.part_number).toBe(idx + 1);
        expect(typeof part.url).toBe('string');
        expect(part.url.length).toBeGreaterThan(0);
        expect(Number.isNaN(Date.parse(part.expires_at))).toBe(false);
        expect(Date.parse(part.expires_at)).toBeGreaterThan(Date.now());
      });
      expect(parts.length).toBe(
        Math.ceil(sizeBytes / res.body.part_size_bytes),
      );
    }, 30000);

    it('persists a draft row owned by the authenticated channel', async () => {
      const token = await registerConfirmAndLogin();

      const res = await request(app.getHttpServer())
        .post('/videos')
        .set('Authorization', `Bearer ${token}`)
        .send({ title: 'Video', size_bytes: 1024, mime_type: 'video/mp4' })
        .expect(201);

      const rows = await dataSource.query(
        'SELECT * FROM "videos" WHERE public_id = $1',
        [res.body.public_id],
      );
      expect(rows).toHaveLength(1);
      expect(rows[0].status).toBe('uploading');
      expect(rows[0].storage_key).toBeTruthy();
      expect(rows[0].upload_id).not.toBeNull();
    }, 30000);

    it('issues distinct public_ids across consecutive inits', async () => {
      const token = await registerConfirmAndLogin();

      const res1 = await request(app.getHttpServer())
        .post('/videos')
        .set('Authorization', `Bearer ${token}`)
        .send({ title: 'Video 1', size_bytes: 1024, mime_type: 'video/mp4' })
        .expect(201);
      const res2 = await request(app.getHttpServer())
        .post('/videos')
        .set('Authorization', `Bearer ${token}`)
        .send({ title: 'Video 2', size_bytes: 1024, mime_type: 'video/mp4' })
        .expect(201);

      expect(res1.body.public_id).not.toBe(res2.body.public_id);

      const rows = await dataSource.query(
        'SELECT public_id FROM "videos" WHERE public_id IN ($1, $2)',
        [res1.body.public_id, res2.body.public_id],
      );
      expect(rows).toHaveLength(2);
    }, 30000);
  });

  describe('Admission policy rejection', () => {
    it('rejects a declared size above the 10 GiB ceiling', async () => {
      const token = await registerConfirmAndLogin();

      const res = await request(app.getHttpServer())
        .post('/videos')
        .set('Authorization', `Bearer ${token}`)
        .send({
          title: 'Too big',
          size_bytes: 10737418241,
          mime_type: 'video/mp4',
        })
        .expect(400);

      expect(res.body.error).toBe('VIDEO_SIZE_EXCEEDS_LIMIT');
      expect(res.body.statusCode).toBe(400);
      expect(res.body.message).toBeDefined();

      const rows = await dataSource.query('SELECT * FROM "videos"');
      expect(rows).toHaveLength(0);
    });

    it('rejects a MIME type outside the allowlist', async () => {
      const token = await registerConfirmAndLogin();

      const res = await request(app.getHttpServer())
        .post('/videos')
        .set('Authorization', `Bearer ${token}`)
        .send({
          title: 'Bad type',
          size_bytes: 1024,
          mime_type: 'application/x-msdownload',
        })
        .expect(400);

      expect(res.body.error).toBe('VIDEO_MIME_TYPE_NOT_ACCEPTED');

      const rows = await dataSource.query('SELECT * FROM "videos"');
      expect(rows).toHaveLength(0);
    });
  });

  describe('Authentication boundary', () => {
    it('rejects a request without an access token', async () => {
      const res = await request(app.getHttpServer())
        .post('/videos')
        .send({ title: 'Video', size_bytes: 1024, mime_type: 'video/mp4' })
        .expect(401);

      expect(res.body.public_id).toBeUndefined();

      const rows = await dataSource.query('SELECT * FROM "videos"');
      expect(rows).toHaveLength(0);
    });
  });
});
