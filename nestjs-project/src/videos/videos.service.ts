import { Injectable } from '@nestjs/common';
import type { ConfigType } from '@nestjs/config';
import { Inject } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { QueryFailedError, Repository } from 'typeorm';
import storageConfig from '../config/storage.config';
import { ChannelsService } from '../channels/channels.service';
import { StorageService } from '../storage/storage.service';
import { InitUploadDto } from './dto/init-upload.dto';
import { Video, VideoStatus } from './entities/video.entity';
import {
  VideoMimeTypeNotAcceptedException,
  VideoSizeExceedsLimitException,
} from './exceptions/video.exception';
import { generatePublicId } from './public-id.util';

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
