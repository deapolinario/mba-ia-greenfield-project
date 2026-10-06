import { QueryFailedError } from 'typeorm';
import { Video, VideoStatus } from './entities/video.entity';
import {
  VideoInvalidStateTransitionException,
  VideoMimeTypeNotAcceptedException,
  VideoNotFoundException,
  VideoNotOwnedException,
  VideoNotReadyException,
  VideoSizeExceedsLimitException,
  VideoUploadCompletionFailedException,
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
    findOne: jest.fn(),
  };
  const channelsService = {
    findByUserId: jest.fn().mockResolvedValue({ id: 'channel-1' }),
  };
  const storageService = {
    buildStorageKey: jest.fn((id: string) => `videos/${id}/original`),
    createMultipartUpload: jest.fn().mockResolvedValue('upload-1'),
    presignUploadPart: jest.fn().mockResolvedValue('https://signed-part-url'),
    abortMultipartUpload: jest.fn(),
    completeMultipartUpload: jest.fn().mockResolvedValue(undefined),
    headObject: jest.fn().mockResolvedValue({ ContentLength: 1024 }),
    deleteObject: jest.fn(),
    presignGet: jest.fn().mockResolvedValue('https://signed-get-url'),
  };
  const videoProcessingQueue = {
    add: jest.fn(),
  };
  return {
    videoRepository,
    channelsService,
    storageService,
    videoProcessingQueue,
  };
}

function makeVideo(overrides: Partial<Video> = {}): Video {
  const video = new Video();
  video.id = 'video-1';
  video.public_id = 'abc12345678';
  video.channel_id = 'channel-1';
  video.title = 'Video';
  video.status = VideoStatus.UPLOADING;
  video.storage_key = 'videos/abc12345678/original';
  video.upload_id = 'upload-1';
  video.thumbnail_key = null;
  video.declared_size_bytes = '1024';
  video.declared_mime_type = 'video/mp4';
  video.duration_seconds = null;
  video.metadata = null;
  video.processing_error = null;
  Object.assign(video, overrides);
  return video;
}

describe('VideosService.initUpload', () => {
  it('rejects a declared size above the upload ceiling without touching storage or the DB', async () => {
    const {
      videoRepository,
      channelsService,
      storageService,
      videoProcessingQueue,
    } = makeDeps();
    const service = new VideosService(
      videoRepository as any,
      channelsService as any,
      storageService as any,
      CONFIG as any,
      videoProcessingQueue as any,
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
    const {
      videoRepository,
      channelsService,
      storageService,
      videoProcessingQueue,
    } = makeDeps();
    const service = new VideosService(
      videoRepository as any,
      channelsService as any,
      storageService as any,
      CONFIG as any,
      videoProcessingQueue as any,
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
    const {
      videoRepository,
      channelsService,
      storageService,
      videoProcessingQueue,
    } = makeDeps();
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
      videoProcessingQueue as any,
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
    const {
      videoRepository,
      channelsService,
      storageService,
      videoProcessingQueue,
    } = makeDeps();
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
      videoProcessingQueue as any,
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

describe('VideosService.completeUpload', () => {
  it('rejects completion by a non-owner', async () => {
    const {
      videoRepository,
      channelsService,
      storageService,
      videoProcessingQueue,
    } = makeDeps();
    videoRepository.findOne.mockResolvedValue(makeVideo());
    channelsService.findByUserId.mockResolvedValue({ id: 'other-channel' });
    const service = new VideosService(
      videoRepository as any,
      channelsService as any,
      storageService as any,
      CONFIG as any,
      videoProcessingQueue as any,
    );

    await expect(
      service.completeUpload('user-2', 'abc12345678', {
        parts: [{ part_number: 1, etag: 'etag-1' }],
      }),
    ).rejects.toBeInstanceOf(VideoNotOwnedException);

    expect(storageService.completeMultipartUpload).not.toHaveBeenCalled();
  });

  it('rejects a video that is not in the uploading state', async () => {
    const {
      videoRepository,
      channelsService,
      storageService,
      videoProcessingQueue,
    } = makeDeps();
    videoRepository.findOne.mockResolvedValue(
      makeVideo({ status: VideoStatus.PROCESSING }),
    );
    const service = new VideosService(
      videoRepository as any,
      channelsService as any,
      storageService as any,
      CONFIG as any,
      videoProcessingQueue as any,
    );

    await expect(
      service.completeUpload('user-1', 'abc12345678', {
        parts: [{ part_number: 1, etag: 'etag-1' }],
      }),
    ).rejects.toBeInstanceOf(VideoInvalidStateTransitionException);

    expect(storageService.completeMultipartUpload).not.toHaveBeenCalled();
  });

  it('rejects an unknown public id', async () => {
    const {
      videoRepository,
      channelsService,
      storageService,
      videoProcessingQueue,
    } = makeDeps();
    videoRepository.findOne.mockResolvedValue(null);
    const service = new VideosService(
      videoRepository as any,
      channelsService as any,
      storageService as any,
      CONFIG as any,
      videoProcessingQueue as any,
    );

    await expect(
      service.completeUpload('user-1', 'nonexistent0', {
        parts: [{ part_number: 1, etag: 'etag-1' }],
      }),
    ).rejects.toBeInstanceOf(VideoNotFoundException);

    expect(channelsService.findByUserId).not.toHaveBeenCalled();
  });

  it('deletes the object and fails the video when the real size exceeds the ceiling', async () => {
    const {
      videoRepository,
      channelsService,
      storageService,
      videoProcessingQueue,
    } = makeDeps();
    videoRepository.findOne.mockResolvedValue(makeVideo());
    videoRepository.save.mockResolvedValue(undefined);
    storageService.headObject.mockResolvedValue({
      ContentLength: CONFIG.uploadMaxSizeBytes + 1,
    });
    const service = new VideosService(
      videoRepository as any,
      channelsService as any,
      storageService as any,
      CONFIG as any,
      videoProcessingQueue as any,
    );

    await expect(
      service.completeUpload('user-1', 'abc12345678', {
        parts: [{ part_number: 1, etag: 'etag-1' }],
      }),
    ).rejects.toBeInstanceOf(VideoSizeExceedsLimitException);

    expect(storageService.deleteObject).toHaveBeenCalledWith(
      'videos/abc12345678/original',
    );
    const savedVideo = videoRepository.save.mock.calls[0][0];
    expect(savedVideo.status).toBe(VideoStatus.FAILED);
    expect(videoProcessingQueue.add).not.toHaveBeenCalled();
  });

  it('wraps a storage rejection of CompleteMultipartUpload in a domain exception', async () => {
    const {
      videoRepository,
      channelsService,
      storageService,
      videoProcessingQueue,
    } = makeDeps();
    videoRepository.findOne.mockResolvedValue(makeVideo());
    storageService.completeMultipartUpload.mockRejectedValue(
      new Error('ETag mismatch'),
    );
    const service = new VideosService(
      videoRepository as any,
      channelsService as any,
      storageService as any,
      CONFIG as any,
      videoProcessingQueue as any,
    );

    await expect(
      service.completeUpload('user-1', 'abc12345678', {
        parts: [{ part_number: 1, etag: 'etag-1' }],
      }),
    ).rejects.toBeInstanceOf(VideoUploadCompletionFailedException);
  });

  it('transitions to processing, clears upload_id, and enqueues the job on success', async () => {
    const {
      videoRepository,
      channelsService,
      storageService,
      videoProcessingQueue,
    } = makeDeps();
    videoRepository.findOne.mockResolvedValue(makeVideo());
    videoRepository.save.mockImplementation(async (v: any) => v);
    const service = new VideosService(
      videoRepository as any,
      channelsService as any,
      storageService as any,
      CONFIG as any,
      videoProcessingQueue as any,
    );

    const result = await service.completeUpload('user-1', 'abc12345678', {
      parts: [{ part_number: 1, etag: 'etag-1' }],
    });

    expect(result.status).toBe(VideoStatus.PROCESSING);
    const savedVideo = videoRepository.save.mock.calls[0][0];
    expect(savedVideo.upload_id).toBeNull();
    expect(videoProcessingQueue.add).toHaveBeenCalledWith(
      'video-processing.process',
      {
        videoId: 'video-1',
        publicId: 'abc12345678',
        storageKey: 'videos/abc12345678/original',
      },
    );
  });
});

describe('VideosService.abortUpload', () => {
  it('releases the parts and returns the video to draft', async () => {
    const {
      videoRepository,
      channelsService,
      storageService,
      videoProcessingQueue,
    } = makeDeps();
    videoRepository.findOne.mockResolvedValue(makeVideo());
    videoRepository.save.mockImplementation(async (v: any) => v);
    const service = new VideosService(
      videoRepository as any,
      channelsService as any,
      storageService as any,
      CONFIG as any,
      videoProcessingQueue as any,
    );

    await service.abortUpload('user-1', 'abc12345678');

    expect(storageService.abortMultipartUpload).toHaveBeenCalledWith(
      'videos/abc12345678/original',
      'upload-1',
    );
    const savedVideo = videoRepository.save.mock.calls[0][0];
    expect(savedVideo.status).toBe(VideoStatus.DRAFT);
    expect(savedVideo.upload_id).toBeNull();
  });

  it('rejects abort by a non-owner', async () => {
    const {
      videoRepository,
      channelsService,
      storageService,
      videoProcessingQueue,
    } = makeDeps();
    videoRepository.findOne.mockResolvedValue(makeVideo());
    channelsService.findByUserId.mockResolvedValue({ id: 'other-channel' });
    const service = new VideosService(
      videoRepository as any,
      channelsService as any,
      storageService as any,
      CONFIG as any,
      videoProcessingQueue as any,
    );

    await expect(
      service.abortUpload('user-2', 'abc12345678'),
    ).rejects.toBeInstanceOf(VideoNotOwnedException);
    expect(storageService.abortMultipartUpload).not.toHaveBeenCalled();
  });

  it('rejects a video that is not in the uploading state', async () => {
    const {
      videoRepository,
      channelsService,
      storageService,
      videoProcessingQueue,
    } = makeDeps();
    videoRepository.findOne.mockResolvedValue(
      makeVideo({ status: VideoStatus.DRAFT }),
    );
    const service = new VideosService(
      videoRepository as any,
      channelsService as any,
      storageService as any,
      CONFIG as any,
      videoProcessingQueue as any,
    );

    await expect(
      service.abortUpload('user-1', 'abc12345678'),
    ).rejects.toBeInstanceOf(VideoInvalidStateTransitionException);
  });
});

describe('VideosService.buildStreamUrl / buildDownloadUrl', () => {
  it('rejects a non-owner before presigning anything', async () => {
    const {
      videoRepository,
      channelsService,
      storageService,
      videoProcessingQueue,
    } = makeDeps();
    videoRepository.findOne.mockResolvedValue(
      makeVideo({ status: VideoStatus.READY }),
    );
    channelsService.findByUserId.mockResolvedValue({ id: 'other-channel' });
    const service = new VideosService(
      videoRepository as any,
      channelsService as any,
      storageService as any,
      CONFIG as any,
      videoProcessingQueue as any,
    );

    await expect(
      service.buildStreamUrl('user-2', 'abc12345678'),
    ).rejects.toBeInstanceOf(VideoNotOwnedException);
    expect(storageService.presignGet).not.toHaveBeenCalled();
  });

  it('rejects an unknown public id before presigning anything', async () => {
    const {
      videoRepository,
      channelsService,
      storageService,
      videoProcessingQueue,
    } = makeDeps();
    videoRepository.findOne.mockResolvedValue(null);
    const service = new VideosService(
      videoRepository as any,
      channelsService as any,
      storageService as any,
      CONFIG as any,
      videoProcessingQueue as any,
    );

    await expect(
      service.buildDownloadUrl('user-1', 'nonexistent0'),
    ).rejects.toBeInstanceOf(VideoNotFoundException);
    expect(storageService.presignGet).not.toHaveBeenCalled();
  });

  it.each([
    VideoStatus.DRAFT,
    VideoStatus.UPLOADING,
    VideoStatus.PROCESSING,
    VideoStatus.FAILED,
  ])('rejects buildStreamUrl when status is %s', async (status) => {
    const {
      videoRepository,
      channelsService,
      storageService,
      videoProcessingQueue,
    } = makeDeps();
    videoRepository.findOne.mockResolvedValue(makeVideo({ status }));
    const service = new VideosService(
      videoRepository as any,
      channelsService as any,
      storageService as any,
      CONFIG as any,
      videoProcessingQueue as any,
    );

    await expect(
      service.buildStreamUrl('user-1', 'abc12345678'),
    ).rejects.toBeInstanceOf(VideoNotReadyException);
    expect(storageService.presignGet).not.toHaveBeenCalled();
  });

  it('presigns a plain GET for stream when ready', async () => {
    const {
      videoRepository,
      channelsService,
      storageService,
      videoProcessingQueue,
    } = makeDeps();
    const video = makeVideo({ status: VideoStatus.READY });
    videoRepository.findOne.mockResolvedValue(video);
    const service = new VideosService(
      videoRepository as any,
      channelsService as any,
      storageService as any,
      CONFIG as any,
      videoProcessingQueue as any,
    );

    const url = await service.buildStreamUrl('user-1', 'abc12345678');

    expect(url).toBe('https://signed-get-url');
    expect(storageService.presignGet).toHaveBeenCalledWith(video.storage_key);
  });

  it('presigns a GET with the attachment disposition override for download', async () => {
    const {
      videoRepository,
      channelsService,
      storageService,
      videoProcessingQueue,
    } = makeDeps();
    const video = makeVideo({ status: VideoStatus.READY });
    videoRepository.findOne.mockResolvedValue(video);
    const service = new VideosService(
      videoRepository as any,
      channelsService as any,
      storageService as any,
      CONFIG as any,
      videoProcessingQueue as any,
    );

    await service.buildDownloadUrl('user-1', 'abc12345678');

    expect(storageService.presignGet).toHaveBeenCalledWith(
      video.storage_key,
      'attachment',
    );
  });
});
