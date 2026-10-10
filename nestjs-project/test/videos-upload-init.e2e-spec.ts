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
import { MailService } from '../src/mail/mail.service';
import { cleanAllTables } from '../src/test/create-test-data-source';

interface LoginResponseBody {
  access_token: string;
}

interface VideoPartResponse {
  part_number: number;
  url: string;
  expires_at: string;
}

interface VideoInitResponseBody {
  public_id: string;
  status: string;
  upload_id: string;
  part_size_bytes: number;
  parts: VideoPartResponse[];
}

interface VideoAdmissionErrorBody {
  error: string;
  statusCode: number;
  message: string | string[];
}

interface VideoRow {
  public_id: string;
  status: string;
  storage_key: string;
  upload_id: string | null;
}

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
    const mailServiceInstance = (
      authService as unknown as { mailService: MailService }
    ).mailService;
    let capturedToken = '';
    jest
      .spyOn(mailServiceInstance, 'sendConfirmationEmail')
      .mockImplementationOnce((_e: string, _n: string, t: string) => {
        capturedToken = t;
        return Promise.resolve();
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

    return (res.body as LoginResponseBody).access_token;
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

      const body = res.body as VideoInitResponseBody;
      expect(typeof body.public_id).toBe('string');
      expect(body.public_id.length).toBeGreaterThan(0);
      expect(body.status).toBe('uploading');
      expect(typeof body.upload_id).toBe('string');
      expect(body.upload_id.length).toBeGreaterThan(0);
      expect(typeof body.part_size_bytes).toBe('number');
      expect(Array.isArray(body.parts)).toBe(true);
      expect(body.parts.length).toBeGreaterThan(0);
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

      const body = res.body as VideoInitResponseBody;
      const parts = body.parts;
      parts.forEach((part, idx) => {
        expect(part.part_number).toBe(idx + 1);
        expect(typeof part.url).toBe('string');
        expect(part.url.length).toBeGreaterThan(0);
        expect(Number.isNaN(Date.parse(part.expires_at))).toBe(false);
        expect(Date.parse(part.expires_at)).toBeGreaterThan(Date.now());
      });
      expect(parts.length).toBe(Math.ceil(sizeBytes / body.part_size_bytes));
    }, 30000);

    it('persists a draft row owned by the authenticated channel', async () => {
      const token = await registerConfirmAndLogin();

      const res = await request(app.getHttpServer())
        .post('/videos')
        .set('Authorization', `Bearer ${token}`)
        .send({ title: 'Video', size_bytes: 1024, mime_type: 'video/mp4' })
        .expect(201);

      const body = res.body as VideoInitResponseBody;
      const rows = await dataSource.query<VideoRow[]>(
        'SELECT * FROM "videos" WHERE public_id = $1',
        [body.public_id],
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

      const body1 = res1.body as VideoInitResponseBody;
      const body2 = res2.body as VideoInitResponseBody;
      expect(body1.public_id).not.toBe(body2.public_id);

      const rows = await dataSource.query<VideoRow[]>(
        'SELECT public_id FROM "videos" WHERE public_id IN ($1, $2)',
        [body1.public_id, body2.public_id],
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

      const body = res.body as VideoAdmissionErrorBody;
      expect(body.error).toBe('VIDEO_SIZE_EXCEEDS_LIMIT');
      expect(body.statusCode).toBe(400);
      expect(body.message).toBeDefined();

      const rows = await dataSource.query<VideoRow[]>('SELECT * FROM "videos"');
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

      const body = res.body as VideoAdmissionErrorBody;
      expect(body.error).toBe('VIDEO_MIME_TYPE_NOT_ACCEPTED');

      const rows = await dataSource.query<VideoRow[]>('SELECT * FROM "videos"');
      expect(rows).toHaveLength(0);
    });
  });

  describe('Authentication boundary', () => {
    it('rejects a request without an access token', async () => {
      const res = await request(app.getHttpServer())
        .post('/videos')
        .send({ title: 'Video', size_bytes: 1024, mime_type: 'video/mp4' })
        .expect(401);

      const body = res.body as Partial<VideoInitResponseBody>;
      expect(body.public_id).toBeUndefined();

      const rows = await dataSource.query<VideoRow[]>('SELECT * FROM "videos"');
      expect(rows).toHaveLength(0);
    });
  });
});
