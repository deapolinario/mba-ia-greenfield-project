import { ListMultipartUploadsCommand, S3Client } from '@aws-sdk/client-s3';
import { ConfigModule } from '@nestjs/config';
import { Test, TestingModule } from '@nestjs/testing';
import { randomUUID } from 'node:crypto';
import storageConfig from '../config/storage.config';
import { S3_CLIENT } from './s3-client.provider';
import { StorageModule } from './storage.module';
import { StorageService } from './storage.service';

describe('StorageService (integration)', () => {
  let moduleRef: TestingModule;
  let service: StorageService;
  let s3Client: S3Client;
  let bucket: string;

  beforeAll(async () => {
    moduleRef = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({ isGlobal: true, load: [storageConfig] }),
        StorageModule,
      ],
    }).compile();

    service = moduleRef.get(StorageService);
    s3Client = moduleRef.get(S3_CLIENT);
    bucket = storageConfig().s3Bucket as string;
  });

  afterAll(async () => {
    await moduleRef.close();
  });

  it('should build the exact source and thumbnail object keys', () => {
    expect(service.buildStorageKey('abc123')).toBe('videos/abc123/original');
    expect(service.buildThumbnailKey('abc123')).toBe(
      'videos/abc123/thumbnail.jpg',
    );
  });

  it('should run a full multipart cycle and report the correct total size via headObject', async () => {
    const key = service.buildStorageKey(randomUUID());
    const uploadId = await service.createMultipartUpload(key, 'video/mp4');

    const partBody = Buffer.alloc(5 * 1024 * 1024, 'a');
    const presignedUrl = await service.presignUploadPart(key, uploadId, 1);

    const putResponse = await fetch(presignedUrl, {
      method: 'PUT',
      body: partBody,
    });
    expect(putResponse.status).toBe(200);
    const etag = putResponse.headers.get('etag') as string;
    expect(etag).toBeTruthy();

    await service.completeMultipartUpload(key, uploadId, [
      { ETag: etag, PartNumber: 1 },
    ]);

    const head = await service.headObject(key);
    expect(head.ContentLength).toBe(partBody.length);

    await service.deleteObject(key);
  }, 30000);

  it('should serve the object via a presigned GET URL and support Range requests (206)', async () => {
    const key = service.buildStorageKey(randomUUID());
    await service.putObject(key, Buffer.from('hello world'), 'text/plain');

    const getUrl = await service.presignGet(key);
    const rangeResponse = await fetch(getUrl, {
      headers: { Range: 'bytes=0-4' },
    });
    expect(rangeResponse.status).toBe(206);

    await service.deleteObject(key);
  });

  it('should release parts on abortMultipartUpload — upload no longer appears in the in-progress listing', async () => {
    const key = service.buildStorageKey(randomUUID());
    const uploadId = await service.createMultipartUpload(key, 'video/mp4');

    await service.abortMultipartUpload(key, uploadId);

    const { Uploads } = await s3Client.send(
      new ListMultipartUploadsCommand({ Bucket: bucket }),
    );
    expect((Uploads ?? []).some((u) => u.UploadId === uploadId)).toBe(false);
  });
});
