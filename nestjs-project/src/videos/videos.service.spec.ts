import { QueryFailedError } from 'typeorm';
import { VideoStatus } from './entities/video.entity';
import {
  VideoMimeTypeNotAcceptedException,
  VideoSizeExceedsLimitException,
} from './exceptions/video.exception';
import { VideosService } from './videos.service';

function makeUniqueError(column: string): QueryFailedError {
  const err = new QueryFailedError('INSERT', [], new Error()) as any;
  err.code = '23505';
  err.detail = `Key (${column})=(x) already exists.`;
  return err;
}

const CONFIG = {
  uploadMaxSizeBytes: 10737418240,
  uploadAcceptedMimeTypes: ['video/mp4', 'video/webm'],
  uploadPartSizeBytes: 8388608,
  presignUploadTtlSeconds: 3600,
};

function makeDeps() {
  const videoRepository = {
    create: jest.fn((entity: any) => entity),
    save: jest.fn(),
  };
  const channelsService = {
    findByUserId: jest.fn().mockResolvedValue({ id: 'channel-1' }),
  };
  const storageService = {
    buildStorageKey: jest.fn((id: string) => `videos/${id}/original`),
    createMultipartUpload: jest.fn().mockResolvedValue('upload-1'),
    presignUploadPart: jest.fn().mockResolvedValue('https://signed-part-url'),
    abortMultipartUpload: jest.fn(),
  };
  return { videoRepository, channelsService, storageService };
}

describe('VideosService.initUpload', () => {
  it('rejects a declared size above the upload ceiling without touching storage or the DB', async () => {
    const { videoRepository, channelsService, storageService } = makeDeps();
    const service = new VideosService(
      videoRepository as any,
      channelsService as any,
      storageService as any,
      CONFIG as any,
    );

    await expect(
      service.initUpload('user-1', {
        title: 'Video',
        size_bytes: CONFIG.uploadMaxSizeBytes + 1,
        mime_type: 'video/mp4',
      }),
    ).rejects.toBeInstanceOf(VideoSizeExceedsLimitException);

    expect(channelsService.findByUserId).not.toHaveBeenCalled();
    expect(storageService.createMultipartUpload).not.toHaveBeenCalled();
  });

  it('rejects a MIME type outside the allowlist', async () => {
    const { videoRepository, channelsService, storageService } = makeDeps();
    const service = new VideosService(
      videoRepository as any,
      channelsService as any,
      storageService as any,
      CONFIG as any,
    );

    await expect(
      service.initUpload('user-1', {
        title: 'Video',
        size_bytes: 1024,
        mime_type: 'application/x-msdownload',
      }),
    ).rejects.toBeInstanceOf(VideoMimeTypeNotAcceptedException);

    expect(storageService.createMultipartUpload).not.toHaveBeenCalled();
  });

  it('retries with a new public_id and aborts the stale multipart upload on a unique-constraint collision', async () => {
    const { videoRepository, channelsService, storageService } = makeDeps();
    videoRepository.save
      .mockRejectedValueOnce(makeUniqueError('public_id'))
      .mockResolvedValueOnce({
        public_id: 'abc12345678',
        status: VideoStatus.UPLOADING,
        upload_id: 'upload-1',
        storage_key: 'videos/abc12345678/original',
      });

    const service = new VideosService(
      videoRepository as any,
      channelsService as any,
      storageService as any,
      CONFIG as any,
    );

    const result = await service.initUpload('user-1', {
      title: 'Video',
      size_bytes: 1024,
      mime_type: 'video/mp4',
    });

    expect(storageService.createMultipartUpload).toHaveBeenCalledTimes(2);
    expect(storageService.abortMultipartUpload).toHaveBeenCalledTimes(1);
    expect(videoRepository.save).toHaveBeenCalledTimes(2);
    expect(result.public_id).toBe('abc12345678');
  });

  it('returns a consecutive 1-based parts array sized to the declared bytes', async () => {
    const { videoRepository, channelsService, storageService } = makeDeps();
    videoRepository.save.mockResolvedValue({
      public_id: 'abc12345678',
      status: VideoStatus.UPLOADING,
      upload_id: 'upload-1',
      storage_key: 'videos/abc12345678/original',
    });

    const service = new VideosService(
      videoRepository as any,
      channelsService as any,
      storageService as any,
      CONFIG as any,
    );

    const result = await service.initUpload('user-1', {
      title: 'Video',
      size_bytes: CONFIG.uploadPartSizeBytes * 2 + 1,
      mime_type: 'video/mp4',
    });

    expect(result.parts).toHaveLength(3);
    expect(result.parts.map((p) => p.part_number)).toEqual([1, 2, 3]);
    expect(result.part_size_bytes).toBe(CONFIG.uploadPartSizeBytes);
    expect(result.status).toBe(VideoStatus.UPLOADING);
    expect(result.upload_id).toBe('upload-1');
  });
});
