import { Inject, Injectable } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import type { ConfigType } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import type { Queue } from 'bullmq';
import { QueryFailedError, Repository } from 'typeorm';
import { ChannelsService } from '../channels/channels.service';
import storageConfig from '../config/storage.config';
import { VIDEO_PROCESSING_QUEUE } from '../queue/queue.module';
import { StorageService } from '../storage/storage.service';
import { CompleteUploadDto } from './dto/complete-upload.dto';
import { InitUploadDto } from './dto/init-upload.dto';
import { Video, VideoStatus } from './entities/video.entity';
import {
  VideoInvalidStateTransitionException,
  VideoMimeTypeNotAcceptedException,
  VideoNotFoundException,
  VideoNotOwnedException,
  VideoSizeExceedsLimitException,
  VideoUploadCompletionFailedException,
} from './exceptions/video.exception';
import { generatePublicId } from './public-id.util';
import {
  VIDEO_PROCESSING_JOB_NAME,
  type VideoProcessingJobPayload,
} from './video-processing.job';

const PG_UNIQUE_VIOLATION = '23505';
const PUBLIC_ID_COLUMN = 'public_id';
const MAX_PUBLIC_ID_RETRIES = 5;

export interface InitUploadPart {
  part_number: number;
  url: string;
  expires_at: string;
}

export interface InitUploadResult {
  public_id: string;
  status: string;
  upload_id: string;
  part_size_bytes: number;
  parts: InitUploadPart[];
}

export interface VideoReadResult {
  public_id: string;
  title: string;
  status: string;
  duration_seconds: number | null;
  metadata: Video['metadata'];
  thumbnail_url: string | null;
  processing_error: string | null;
  created_at: Date;
}

function isPgUniqueViolationOnColumn(err: unknown, column: string): boolean {
  if (!(err instanceof QueryFailedError)) return false;
  const e = err as unknown as { code?: string; detail?: string };
  return (
    e.code === PG_UNIQUE_VIOLATION &&
    typeof e.detail === 'string' &&
    e.detail.includes(column)
  );
}

@Injectable()
export class VideosService {
  constructor(
    @InjectRepository(Video)
    private readonly videoRepository: Repository<Video>,
    private readonly channelsService: ChannelsService,
    private readonly storageService: StorageService,
    @Inject(storageConfig.KEY)
    private readonly config: ConfigType<typeof storageConfig>,
    @InjectQueue(VIDEO_PROCESSING_QUEUE)
    private readonly videoProcessingQueue: Queue<VideoProcessingJobPayload>,
  ) {}

  async initUpload(
    userId: string,
    dto: InitUploadDto,
  ): Promise<InitUploadResult> {
    if (dto.size_bytes > this.config.uploadMaxSizeBytes) {
      throw new VideoSizeExceedsLimitException();
    }
    if (!this.config.uploadAcceptedMimeTypes.includes(dto.mime_type)) {
      throw new VideoMimeTypeNotAcceptedException();
    }

    const channel = await this.channelsService.findByUserId(userId);
    if (!channel) {
      throw new Error('Authenticated user has no owning channel');
    }

    const video = await this.createDraftRowWithRetry(channel.id, dto);

    const partSizeBytes = this.config.uploadPartSizeBytes;
    const numParts = Math.max(1, Math.ceil(dto.size_bytes / partSizeBytes));
    const expiresAt = new Date(
      Date.now() + this.config.presignUploadTtlSeconds * 1000,
    ).toISOString();

    const parts: InitUploadPart[] = [];
    for (let partNumber = 1; partNumber <= numParts; partNumber++) {
      const url = await this.storageService.presignUploadPart(
        video.storage_key,
        video.upload_id as string,
        partNumber,
      );
      parts.push({ part_number: partNumber, url, expires_at: expiresAt });
    }

    return {
      public_id: video.public_id,
      status: video.status,
      upload_id: video.upload_id as string,
      part_size_bytes: partSizeBytes,
      parts,
    };
  }

  async completeUpload(
    userId: string,
    publicId: string,
    dto: CompleteUploadDto,
  ): Promise<{ public_id: string; status: string }> {
    const video = await this.findOwnedVideoOrThrow(userId, publicId);

    if (video.status !== VideoStatus.UPLOADING) {
      throw new VideoInvalidStateTransitionException();
    }

    try {
      await this.storageService.completeMultipartUpload(
        video.storage_key,
        video.upload_id as string,
        dto.parts.map((p) => ({ ETag: p.etag, PartNumber: p.part_number })),
      );
    } catch {
      throw new VideoUploadCompletionFailedException();
    }

    const head = await this.storageService.headObject(video.storage_key);
    if ((head.ContentLength ?? 0) > this.config.uploadMaxSizeBytes) {
      await this.storageService.deleteObject(video.storage_key);
      video.status = VideoStatus.FAILED;
      video.upload_id = null;
      video.processing_error = 'Stored object exceeds the allowed size limit';
      await this.videoRepository.save(video);
      throw new VideoSizeExceedsLimitException();
    }

    video.status = VideoStatus.PROCESSING;
    video.upload_id = null;
    await this.videoRepository.save(video);

    await this.videoProcessingQueue.add(VIDEO_PROCESSING_JOB_NAME, {
      videoId: video.id,
      publicId: video.public_id,
      storageKey: video.storage_key,
    });

    return { public_id: video.public_id, status: video.status };
  }

  async findByPublicIdForOwner(
    userId: string,
    publicId: string,
  ): Promise<VideoReadResult> {
    const video = await this.findOwnedVideoOrThrow(userId, publicId);

    const thumbnailUrl =
      video.status === VideoStatus.READY && video.thumbnail_key
        ? await this.storageService.presignGet(video.thumbnail_key)
        : null;

    return {
      public_id: video.public_id,
      title: video.title,
      status: video.status,
      duration_seconds: video.duration_seconds,
      metadata: video.metadata,
      thumbnail_url: thumbnailUrl,
      processing_error: video.processing_error,
      created_at: video.created_at,
    };
  }

  async abortUpload(userId: string, publicId: string): Promise<void> {
    const video = await this.findOwnedVideoOrThrow(userId, publicId);

    if (video.status !== VideoStatus.UPLOADING) {
      throw new VideoInvalidStateTransitionException();
    }

    await this.storageService.abortMultipartUpload(
      video.storage_key,
      video.upload_id as string,
    );

    video.status = VideoStatus.DRAFT;
    video.upload_id = null;
    await this.videoRepository.save(video);
  }

  private async findOwnedVideoOrThrow(
    userId: string,
    publicId: string,
  ): Promise<Video> {
    const video = await this.videoRepository.findOne({
      where: { public_id: publicId },
    });
    if (!video) {
      throw new VideoNotFoundException();
    }

    const channel = await this.channelsService.findByUserId(userId);
    if (!channel || channel.id !== video.channel_id) {
      throw new VideoNotOwnedException();
    }

    return video;
  }

  private async createDraftRowWithRetry(
    channelId: string,
    dto: InitUploadDto,
  ): Promise<Video> {
    for (let attempt = 0; attempt <= MAX_PUBLIC_ID_RETRIES; attempt++) {
      const publicId = generatePublicId();
      const storageKey = this.storageService.buildStorageKey(publicId);
      const uploadId = await this.storageService.createMultipartUpload(
        storageKey,
        dto.mime_type,
      );

      try {
        return await this.videoRepository.save(
          this.videoRepository.create({
            public_id: publicId,
            channel_id: channelId,
            title: dto.title,
            status: VideoStatus.UPLOADING,
            storage_key: storageKey,
            upload_id: uploadId,
            declared_size_bytes: String(dto.size_bytes),
            declared_mime_type: dto.mime_type,
          }),
        );
      } catch (err) {
        await this.storageService.abortMultipartUpload(storageKey, uploadId);
        if (isPgUniqueViolationOnColumn(err, PUBLIC_ID_COLUMN)) {
          continue;
        }
        throw err;
      }
    }

    throw new Error(
      'public_id conflict could not be resolved after max retries',
    );
  }
}
